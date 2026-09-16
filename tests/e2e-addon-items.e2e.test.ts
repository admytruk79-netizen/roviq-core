import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

const ADMIN_KEY = process.env.ADMIN_API_KEY!;
function adminHeaders() { return { 'x-roviq-role': 'admin', 'x-admin-api-key': ADMIN_KEY }; }
function actorHeaders(role: string, actorId: string) { return { 'x-roviq-role': role, 'x-roviq-actor-id': actorId }; }

// Business Plan Section 4A: shop-flagged add-on items get a three-tier customer-approval model --
// Critical (cannot be silently removed; requires an explicit, written decline to proceed without
// it), Urgent (same-visit approve/decline), and Flexible (approve, defer, or shop to a different
// partner for a competing quote).
describe('add-to-order: three-tier severity model', () => {
  let app: FastifyInstance;
  let customerActorId: string;
  let shopActorId: string;
  let otherShopActorId: string;
  let caseId: string;

  async function createCase() {
    const domain = await pool.query(`select id from domains where code='maintenance' limit 1`);
    const c = await pool.query(
      `insert into service_cases(domain_id,case_type,state,customer_actor_id) values($1,'maintenance','repair_in_progress',$2) returning id`,
      [domain.rows[0].id, customerActorId]
    );
    await pool.query(`update service_cases set current_owner_role='partner',current_owner_actor_id=$2 where id=$1`, [c.rows[0].id, shopActorId]);
    return c.rows[0].id as string;
  }

  beforeAll(async () => {
    app = await buildApp();
    const customer = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'customer' } });
    customerActorId = JSON.parse(customer.body).actor.id;
    const shop = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'partner' } });
    shopActorId = JSON.parse(shop.body).actor.id;
    const otherShop = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'partner' } });
    otherShopActorId = JSON.parse(otherShop.body).actor.id;
    caseId = await createCase();
  });

  afterAll(async () => { await pool.end(); });

  it('critical: cannot be silently removed, requires an explicit written decline to proceed without it', async () => {
    const flagRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/addon-items`, headers: actorHeaders('partner', shopActorId),
      payload: { severity: 'critical', description: 'Brake line corrosion found, unsafe to drive without repair', amountMinor: 45000 }
    });
    expect(flagRes.statusCode).toBe(201);
    const item = JSON.parse(flagRes.body).item;
    expect(item.status).toBe('pending');

    // A bare rejection isn't an allowed decision for a critical item -- only approve or an
    // explicit, written acknowledged decline.
    const badDecision = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/addon-items/${item.id}/decision`, headers: actorHeaders('customer', customerActorId),
      payload: { decision: 'deferred' }
    });
    expect(badDecision.statusCode).toBe(409);
    expect(JSON.parse(badDecision.body).error).toBe('addon_decision_not_allowed_for_severity');

    // Declining a critical item without a reason is rejected -- the decline must be in writing.
    const noReasonDecline = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/addon-items/${item.id}/decision`, headers: actorHeaders('customer', customerActorId),
      payload: { decision: 'declined_acknowledged' }
    });
    expect(noReasonDecline.statusCode).toBe(409);
    expect(JSON.parse(noReasonDecline.body).error).toBe('critical_decline_reason_required');

    const declineRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/addon-items/${item.id}/decision`, headers: actorHeaders('customer', customerActorId),
      payload: { decision: 'declined_acknowledged', reason: 'I understand the risk and choose not to repair this now.' }
    });
    expect(declineRes.statusCode).toBe(200);
    expect(JSON.parse(declineRes.body).item.status).toBe('declined_acknowledged');
  });

  it('flexible: can be deferred and then shopped to a different partner for a competing quote', async () => {
    const flagRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/addon-items`, headers: actorHeaders('partner', shopActorId),
      payload: { severity: 'flexible', description: 'Cabin air filter looks due, not urgent', amountMinor: 4000 }
    });
    const item = JSON.parse(flagRes.body).item;

    const deferRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/addon-items/${item.id}/decision`, headers: actorHeaders('customer', customerActorId),
      payload: { decision: 'deferred' }
    });
    expect(deferRes.statusCode).toBe(200);

    const shopRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/addon-items/${item.id}/request-competing-quote`, headers: actorHeaders('customer', customerActorId)
    });
    expect(shopRes.statusCode).toBe(200);
    expect(JSON.parse(shopRes.body).item.status).toBe('sent_for_competing_quote');

    // The flagging shop cannot quote its own item.
    const selfQuote = await app.inject({
      method: 'POST', url: `/api/addon-items/${item.id}/competing-quotes`, headers: actorHeaders('partner', shopActorId),
      payload: { amountMinor: 3500 }
    });
    expect(selfQuote.statusCode).toBe(409);
    expect(JSON.parse(selfQuote.body).error).toBe('cannot_quote_own_flagged_item');

    // It shows up on the open board for a different partner, who submits a competing quote.
    const boardRes = await app.inject({ method: 'GET', url: '/api/partners/me/competing-quote-requests', headers: actorHeaders('partner', otherShopActorId) });
    expect(boardRes.statusCode).toBe(200);
    expect(JSON.parse(boardRes.body).requests.some((r: { id: string }) => r.id === item.id)).toBe(true);

    const quoteRes = await app.inject({
      method: 'POST', url: `/api/addon-items/${item.id}/competing-quotes`, headers: actorHeaders('partner', otherShopActorId),
      payload: { amountMinor: 3200, notes: 'Can do it same day' }
    });
    expect(quoteRes.statusCode).toBe(201);
    const quote = JSON.parse(quoteRes.body).quote;

    const quotesListRes = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}/addon-items/${item.id}/competing-quotes`, headers: actorHeaders('customer', customerActorId) });
    expect(quotesListRes.statusCode).toBe(200);
    expect(JSON.parse(quotesListRes.body).quotes).toHaveLength(1);

    const selectRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/addon-items/${item.id}/competing-quotes/${quote.id}/select`, headers: actorHeaders('customer', customerActorId)
    });
    expect(selectRes.statusCode).toBe(200);
    const decided = JSON.parse(selectRes.body).item;
    expect(decided.status).toBe('approved');
    expect(Number(decided.amount_minor)).toBe(3200);
  });

  it('urgent: a stranger cannot flag or decide, and a case-related actor can approve inline', async () => {
    const strangerFlag = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/addon-items`, headers: actorHeaders('partner', otherShopActorId),
      payload: { severity: 'urgent', description: 'Suspicious noise from the front left wheel', amountMinor: 15000 }
    });
    expect(strangerFlag.statusCode).toBe(403);

    const flagRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/addon-items`, headers: actorHeaders('partner', shopActorId),
      payload: { severity: 'urgent', description: 'Suspicious noise from the front left wheel', amountMinor: 15000 }
    });
    const item = JSON.parse(flagRes.body).item;

    const approveRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/addon-items/${item.id}/decision`, headers: actorHeaders('customer', customerActorId),
      payload: { decision: 'approved' }
    });
    expect(approveRes.statusCode).toBe(200);
    expect(JSON.parse(approveRes.body).item.status).toBe('approved');

    const secondDecision = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/addon-items/${item.id}/decision`, headers: actorHeaders('customer', customerActorId),
      payload: { decision: 'declined_acknowledged', reason: 'changed my mind' }
    });
    expect(secondDecision.statusCode).toBe(409);
    expect(JSON.parse(secondDecision.body).error).toBe('addon_item_already_decided');
  });
});
