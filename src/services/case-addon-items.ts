import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { assertCaseAccess } from './case-access.js';
import { audit } from './audit.js';
import { appendCaseEvent } from './case-events.js';
import { setCustomerSnapshot } from './operations.js';

export type AddonSeverity = 'critical' | 'urgent' | 'flexible';
export type AddonDecision = 'approved' | 'declined_acknowledged' | 'deferred';

const SEVERITY_ALLOWED_DECISIONS: Record<AddonSeverity, AddonDecision[]> = {
  // Critical: cannot be silently removed -- the customer must explicitly approve or acknowledge
  // and decline in writing. No silent defer.
  critical: ['approved', 'declined_acknowledged'],
  // Urgent: needs a same-visit decision, but is still a real approve/decline choice.
  urgent: ['approved', 'declined_acknowledged'],
  // Flexible: approve now, defer, or (via requestCompetingQuote) shop it to another partner.
  flexible: ['approved', 'deferred']
};

async function assertShopSideActor(principal: Principal, caseId: string) {
  if (principal.role === 'admin') return;
  const c = await pool.query('select current_owner_actor_id,selected_actor_id from service_cases where id=$1', [caseId]);
  if (!c.rowCount) throw new Error('case_not_found');
  const row = c.rows[0];
  if (principal.actorId && (principal.actorId === row.current_owner_actor_id || principal.actorId === row.selected_actor_id)) return;
  throw new Error('forbidden');
}

async function assertCustomerOrAdmin(principal: Principal, caseId: string) {
  if (principal.role === 'admin') return;
  const c = await pool.query('select customer_actor_id from service_cases where id=$1', [caseId]);
  if (!c.rowCount) throw new Error('case_not_found');
  if (principal.actorId && principal.actorId === c.rows[0].customer_actor_id) return;
  throw new Error('forbidden');
}

export async function flagAddonItem(principal: Principal, caseId: string, input: {
  severity: AddonSeverity; description: string; amountMinor?: number; currency?: string;
}) {
  await assertCaseAccess(principal, caseId);
  await assertShopSideActor(principal, caseId);
  const plan = await pool.query('select id from service_plans where case_id=$1', [caseId]);
  const r = await pool.query(
    `insert into case_addon_items(case_id,service_plan_id,flagged_by_actor_id,severity,description,amount_minor,currency)
     values($1,$2,$3,$4,$5,$6,$7) returning *`,
    [caseId, plan.rows[0]?.id ?? null, principal.actorId ?? null, input.severity, input.description, input.amountMinor ?? null, (input.currency ?? 'USD').toUpperCase()]
  );
  const item = r.rows[0];
  await appendCaseEvent(caseId, 'ADDON_ITEM_FLAGGED', principal, { itemId: item.id, severity: item.severity, description: item.description });
  await setCustomerSnapshot(
    caseId,
    'addon_item_pending',
    item.severity === 'critical' ? 'Your shop found a safety-critical issue that needs your decision.' : 'Your shop found additional work and needs your decision.',
    item.severity === 'critical' ? 'Review and decide now' : 'Review when ready'
  );
  await audit(principal, 'flag_addon_item', 'case_addon_item', item.id, item.severity, { caseId });
  return item;
}

export async function listAddonItems(principal: Principal, caseId: string) {
  await assertCaseAccess(principal, caseId);
  const r = await pool.query('select * from case_addon_items where case_id=$1 order by created_at asc', [caseId]);
  return r.rows;
}

export async function decideAddonItem(principal: Principal, caseId: string, itemId: string, decision: AddonDecision, reason?: string) {
  await assertCaseAccess(principal, caseId);
  await assertCustomerOrAdmin(principal, caseId);
  const current = await pool.query('select * from case_addon_items where id=$1 and case_id=$2', [itemId, caseId]);
  if (!current.rowCount) throw new Error('addon_item_not_found');
  const item = current.rows[0];
  if (item.status !== 'pending') throw new Error('addon_item_already_decided');
  const allowed = SEVERITY_ALLOWED_DECISIONS[item.severity as AddonSeverity] ?? [];
  if (!allowed.includes(decision)) throw new Error('addon_decision_not_allowed_for_severity');
  // Critical findings require the decline to be an explicit, written acknowledgment, not a bare
  // rejection -- so a reason is mandatory on that specific path.
  if (decision === 'declined_acknowledged' && item.severity === 'critical' && !reason?.trim()) {
    throw new Error('critical_decline_reason_required');
  }
  const updated = await pool.query(
    `update case_addon_items set status=$1,decision_reason=$2,decided_by_actor_id=$3,decided_at=now(),updated_at=now() where id=$4 returning *`,
    [decision, reason ?? null, principal.actorId ?? null, itemId]
  );
  await appendCaseEvent(caseId, 'ADDON_ITEM_DECIDED', principal, { itemId, decision, severity: item.severity, reason: reason ?? null });
  await audit(principal, 'decide_addon_item', 'case_addon_item', itemId, decision, { caseId, severity: item.severity });
  return updated.rows[0];
}

export async function requestCompetingQuote(principal: Principal, caseId: string, itemId: string) {
  await assertCaseAccess(principal, caseId);
  await assertCustomerOrAdmin(principal, caseId);
  const current = await pool.query('select * from case_addon_items where id=$1 and case_id=$2', [itemId, caseId]);
  if (!current.rowCount) throw new Error('addon_item_not_found');
  const item = current.rows[0];
  if (item.severity !== 'flexible') throw new Error('competing_quote_requires_flexible_severity');
  if (!['pending', 'deferred'].includes(item.status)) throw new Error('addon_item_not_shoppable');
  const updated = await pool.query(
    `update case_addon_items set status='sent_for_competing_quote',updated_at=now() where id=$1 returning *`,
    [itemId]
  );
  await appendCaseEvent(caseId, 'ADDON_ITEM_SENT_FOR_COMPETING_QUOTE', principal, { itemId });
  await audit(principal, 'request_addon_competing_quote', 'case_addon_item', itemId, 'sent_for_competing_quote', { caseId });
  return updated.rows[0];
}

export async function listOpenCompetingQuoteRequests(principal: Principal) {
  // Any partner with repair capability can see flexible items shopped for a competing quote,
  // except ones flagged by their own organization/actor (nothing to compete against yourself).
  const r = await pool.query(
    `select i.id,i.case_id,i.description,i.amount_minor,i.currency,i.created_at,i.updated_at
       from case_addon_items i
       join service_cases sc on sc.id=i.case_id
      where i.status='sent_for_competing_quote'
        and i.flagged_by_actor_id is distinct from $1
        and not exists(select 1 from addon_competing_quotes q where q.addon_item_id=i.id and q.quoting_actor_id=$1)
      order by i.updated_at desc limit 100`,
    [principal.actorId ?? null]
  );
  return r.rows;
}

export async function submitCompetingQuote(principal: Principal, itemId: string, input: { amountMinor: number; currency?: string; notes?: string }) {
  if (!principal.actorId) throw new Error('forbidden');
  const item = await pool.query(`select * from case_addon_items where id=$1`, [itemId]);
  if (!item.rowCount) throw new Error('addon_item_not_found');
  if (item.rows[0].status !== 'sent_for_competing_quote') throw new Error('addon_item_not_open_for_quotes');
  if (item.rows[0].flagged_by_actor_id === principal.actorId) throw new Error('cannot_quote_own_flagged_item');
  const r = await pool.query(
    `insert into addon_competing_quotes(addon_item_id,quoting_actor_id,amount_minor,currency,notes)
     values($1,$2,$3,$4,$5)
     on conflict(addon_item_id,quoting_actor_id) do update set amount_minor=excluded.amount_minor,currency=excluded.currency,notes=excluded.notes
     returning *`,
    [itemId, principal.actorId, input.amountMinor, (input.currency ?? 'USD').toUpperCase(), input.notes ?? null]
  );
  await audit(principal, 'submit_addon_competing_quote', 'addon_competing_quote', r.rows[0].id, 'submitted', { addonItemId: itemId });
  return r.rows[0];
}

export async function listCompetingQuotes(principal: Principal, caseId: string, itemId: string) {
  await assertCaseAccess(principal, caseId);
  await assertCustomerOrAdmin(principal, caseId);
  const item = await pool.query('select id from case_addon_items where id=$1 and case_id=$2', [itemId, caseId]);
  if (!item.rowCount) throw new Error('addon_item_not_found');
  const r = await pool.query('select * from addon_competing_quotes where addon_item_id=$1 order by amount_minor asc', [itemId]);
  return r.rows;
}

export async function selectCompetingQuote(principal: Principal, caseId: string, itemId: string, quoteId: string) {
  await assertCaseAccess(principal, caseId);
  await assertCustomerOrAdmin(principal, caseId);
  const client = await pool.connect();
  try {
    await client.query('begin');
    const item = await client.query('select * from case_addon_items where id=$1 and case_id=$2 for update', [itemId, caseId]);
    if (!item.rowCount) throw new Error('addon_item_not_found');
    if (item.rows[0].status !== 'sent_for_competing_quote') throw new Error('addon_item_not_open_for_quotes');
    const quote = await client.query('select * from addon_competing_quotes where id=$1 and addon_item_id=$2', [quoteId, itemId]);
    if (!quote.rowCount) throw new Error('competing_quote_not_found');
    await client.query(`update addon_competing_quotes set status='selected' where id=$1`, [quoteId]);
    await client.query(`update addon_competing_quotes set status='declined' where addon_item_id=$1 and id<>$2 and status='submitted'`, [itemId, quoteId]);
    const updatedItem = await client.query(
      `update case_addon_items set status='approved',amount_minor=$1,currency=$2,decided_by_actor_id=$3,decided_at=now(),updated_at=now() where id=$4 returning *`,
      [quote.rows[0].amount_minor, quote.rows[0].currency, principal.actorId ?? null, itemId]
    );
    await client.query('commit');
    await appendCaseEvent(caseId, 'ADDON_ITEM_COMPETING_QUOTE_SELECTED', principal, { itemId, quoteId, winningActorId: quote.rows[0].quoting_actor_id });
    await audit(principal, 'select_addon_competing_quote', 'case_addon_item', itemId, 'approved', { caseId, quoteId });
    return updatedItem.rows[0];
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
