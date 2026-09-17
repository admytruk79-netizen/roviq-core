import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';

export type LoanerTier = 'economy' | 'standard' | 'luxury';
const TIER_RANK: Record<LoanerTier, number> = { economy: 0, standard: 1, luxury: 2 };

type ActiveMembership = {
  id: string;
  planKey: string;
  includedDiagnosticsPerPeriod: number;
  maxLoanerTier: LoanerTier;
  diagnosticsUsedThisPeriod: number;
};

// Lazily rolls a membership into its next period instead of a scheduled job -- the same
// "resolve on read" pattern used elsewhere in this codebase for windowed state. Caller must hold
// the row lock (`for update of cm`) already taken by the calling query.
async function rollPeriodIfElapsed(client: Pick<PoolClient, 'query'>, membershipRow: any) {
  if (new Date(membershipRow.current_period_end).getTime() > Date.now()) return membershipRow;
  const rolled = await client.query(
    `update customer_memberships
        set current_period_start = now(),
            current_period_end = now() + ($1 || ' days')::interval,
            diagnostics_used_this_period = 0,
            updated_at = now()
      where id = $2
      returning *`,
    [membershipRow.period_days, membershipRow.id]
  );
  return { ...membershipRow, ...rolled.rows[0] };
}

async function loadActiveMembershipForUpdate(client: Pick<PoolClient, 'query'>, customerActorId: string) {
  const row = await client.query(
    `select cm.*, mp.plan_key, mp.included_diagnostics_per_period, mp.period_days, mp.max_loaner_tier
       from customer_memberships cm
       join membership_plans mp on mp.id = cm.plan_id
      where cm.customer_actor_id = $1 and cm.status = 'active'
      for update of cm`,
    [customerActorId]
  );
  if (!row.rowCount) return null;
  return rollPeriodIfElapsed(client, row.rows[0]);
}

// A customer with no active membership row is treated as the free tier (no included visits,
// economy-only loaners) rather than as an error, since most customers won't have opted into a
// paid plan at all.
export async function getActiveMembership(customerActorId: string): Promise<ActiveMembership | null> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const m = await loadActiveMembershipForUpdate(client, customerActorId);
    await client.query('commit');
    if (!m) return null;
    return {
      id: m.id,
      planKey: m.plan_key,
      includedDiagnosticsPerPeriod: m.included_diagnostics_per_period,
      maxLoanerTier: m.max_loaner_tier as LoanerTier,
      diagnosticsUsedThisPeriod: m.diagnostics_used_this_period
    };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function maxLoanerTierFor(customerActorId: string | null | undefined): Promise<LoanerTier> {
  if (!customerActorId) return 'economy';
  const membership = await getActiveMembership(customerActorId);
  return membership?.maxLoanerTier ?? 'economy';
}

export function loanerTierPermitted(requestedTier: LoanerTier, maxTier: LoanerTier): boolean {
  return TIER_RANK[requestedTier] <= TIER_RANK[maxTier];
}

/**
 * Atomically consumes one diagnostic visit against the customer's membership quota, if they have
 * one and haven't exhausted it this period. Returns true when the visit is covered (no standalone
 * fee should be charged), false when the caller still owes the standalone diagnostic fee -- either
 * because there's no active membership, or its quota for this period is used up.
 */
export async function consumeDiagnosticQuota(customerActorId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const m = await loadActiveMembershipForUpdate(client, customerActorId);
    if (!m || m.diagnostics_used_this_period >= m.included_diagnostics_per_period) {
      await client.query('commit');
      return false;
    }
    await client.query(
      `update customer_memberships set diagnostics_used_this_period = diagnostics_used_this_period + 1, updated_at = now() where id = $1`,
      [m.id]
    );
    await client.query('commit');
    return true;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
