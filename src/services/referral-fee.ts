import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';

type Queryable = Pick<PoolClient, 'query'>;

type FeeTier = { maxAmountMinor: number | null; percent: number };

export type ReferralFeeBreakdown = {
  jobValueMinor: number;
  feeMinor: number;
  partnerPayableMinor: number;
  percent: number;
  currency: string;
  policyId: string;
};

async function loadActiveReferralFeePolicy(domainId: string, db: Queryable) {
  const r = await db.query(
    `select * from referral_fee_policies where domain_id=$1 and policy_key='referral_fee_default' and active=true order by version desc limit 1`,
    [domainId]
  );
  return r.rows[0] ?? null;
}

/** Business Plan Section 4/6A: the shop pays a referral fee scaled to job complexity (job value). */
export function computeReferralFee(jobValueMinor: number, policy: { configuration: { tiers: FeeTier[] } }): { feeMinor: number; percent: number } {
  const tiers = Array.isArray(policy.configuration?.tiers) ? policy.configuration.tiers : [];
  const sorted = [...tiers].sort((a, b) => (a.maxAmountMinor ?? Infinity) - (b.maxAmountMinor ?? Infinity));
  const tier = sorted.find((t) => t.maxAmountMinor === null || jobValueMinor <= t.maxAmountMinor) ?? sorted[sorted.length - 1];
  const percent = tier ? Number(tier.percent) : 0;
  const feeMinor = Math.round((jobValueMinor * percent) / 100);
  return { feeMinor, percent };
}

/**
 * Posts the platform-revenue / partner-payable split for a case's net captured payments,
 * once, at case completion. Fails closed (posts nothing) when there's no active fee policy or
 * no net captured payment -- matching the fail-closed pattern already used by routing policies,
 * rather than guessing at a fee with no configured basis.
 */
export async function postCaseRevenueAllocation(caseId: string, db: Queryable = pool): Promise<ReferralFeeBreakdown | null> {
  const already = await db.query(`select 1 from revenue_allocations where case_id=$1 and recognition_basis='case_completion' limit 1`, [caseId]);
  if (already.rowCount) return null;

  const caseRow = await db.query(`select domain_id from service_cases where id=$1`, [caseId]);
  if (!caseRow.rowCount) return null;
  const domainId = caseRow.rows[0].domain_id;
  if (!domainId) return null;

  const policy = await loadActiveReferralFeePolicy(domainId, db);
  if (!policy) return null;

  const captured = await db.query(
    `select p.id, p.amount, p.currency,
            coalesce((select sum(amount) from payment_events e where e.payment_intent_id=p.id and e.event_type='REFUND'),0)::numeric as refunded
       from payment_intents p
      where p.case_id=$1 and p.state in ('captured','partially_refunded','refunded')`,
    [caseId]
  );
  if (!captured.rowCount) return null;

  const currency = String(captured.rows[0].currency ?? policy.configuration?.currency ?? 'USD').toUpperCase();
  const factor = currency === 'JPY' ? 1 : 100;
  let netMinor = 0;
  for (const row of captured.rows) {
    const net = Number(row.amount) - Number(row.refunded);
    if (net > 0) netMinor += Math.round(net * factor);
  }
  if (netMinor <= 0) return null;

  const { feeMinor, percent } = computeReferralFee(netMinor, policy);
  const partnerPayableMinor = netMinor - feeMinor;

  await db.query(
    `insert into revenue_allocations(case_id, allocation_type, amount_minor, currency, recognition_basis, metadata)
     values($1,'platform_revenue',$2,$3,'case_completion',$4)`,
    [caseId, feeMinor, currency, JSON.stringify({ policyId: policy.id, percent, jobValueMinor: netMinor })]
  );
  await db.query(
    `insert into revenue_allocations(case_id, allocation_type, amount_minor, currency, recognition_basis, metadata)
     values($1,'partner_payable',$2,$3,'case_completion',$4)`,
    [caseId, partnerPayableMinor, currency, JSON.stringify({ policyId: policy.id, percent, jobValueMinor: netMinor })]
  );

  return { jobValueMinor: netMinor, feeMinor, partnerPayableMinor, percent, currency, policyId: policy.id };
}
