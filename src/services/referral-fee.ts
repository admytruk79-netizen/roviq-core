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
  payoutId: string | null;
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

  const caseRow = await db.query(`select domain_id, selected_actor_id from service_cases where id=$1`, [caseId]);
  if (!caseRow.rowCount) return null;
  const domainId = caseRow.rows[0].domain_id;
  const selectedActorId = caseRow.rows[0].selected_actor_id as string | null;
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

  const payoutId = await proposePartnerPayout(caseId, selectedActorId, partnerPayableMinor, currency, factor, captured.rows, policy.id, db);

  return { jobValueMinor: netMinor, feeMinor, partnerPayableMinor, percent, currency, policyId: policy.id, payoutId };
}

/**
 * The partner_payable split above is a bookkeeping entry, not an instruction to actually pay
 * anyone -- without this, "what the shop is owed" only ever existed as a number an admin had to
 * notice and turn into a payout by hand. Auto-propose the payout in the same transaction so it
 * shows up in the partner's own payout list and the admin payout queue immediately at case
 * completion. It still lands in 'pending' (the existing settlement_payouts default): an admin
 * approves/processes/marks it paid through the existing payout-state endpoints, same as a
 * manually created payout. Fails closed (proposes nothing) when there's no selected provider to
 * pay, the provider isn't active, or there's nothing owed.
 */
async function proposePartnerPayout(
  caseId: string,
  selectedActorId: string | null,
  partnerPayableMinor: number,
  currency: string,
  factor: number,
  capturedPayments: { id: string }[],
  policyId: string,
  db: Queryable
): Promise<string | null> {
  if (!selectedActorId || partnerPayableMinor <= 0) return null;
  const actor = await db.query(`select id from actors where id=$1 and status='active'`, [selectedActorId]);
  if (!actor.rowCount) return null;
  // Only attach the payout to a specific payment intent when the case had exactly one captured
  // intent to attribute it to -- with more than one, the split across intents is ambiguous, so
  // leave the payout unlinked rather than guess which capture it belongs to.
  const paymentIntentId = capturedPayments.length === 1 ? capturedPayments[0].id : null;
  const amount = partnerPayableMinor / factor;
  const r = await db.query(
    `insert into settlement_payouts(case_id, counterparty_actor_id, payment_intent_id, amount, currency, provider, metadata)
     values($1,$2,$3,$4,$5,'manual',$6) returning id`,
    [caseId, selectedActorId, paymentIntentId, amount, currency, JSON.stringify({ source: 'auto_referral_fee_allocation', policyId })]
  );
  return r.rows[0].id as string;
}
