import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
const admin = { 'x-roviq-role': 'admin', 'x-admin-api-key': process.env.ADMIN_API_KEY! };
const header = (role: string, actor: string) => ({ 'x-roviq-role': role, 'x-roviq-actor-id': actor });
describe('business credential handshake at authoritative write boundaries', () => {
  let app: FastifyInstance; let actor: string; let org: string; let customer: string;
  beforeAll(async () => {
    app = await buildApp(); actor = randomUUID();
    const result = await app.inject({ method: 'POST', url: '/api/admin/business-onboarding', headers: admin,
      payload: { requestId: actor, role: 'tow', businessName: `Credential pilot ${actor}`, operatorName: 'Licensed operator',
        email: `${actor}@example.test`, password: 'Credential-pilot-123!',
        location: { name: 'Main', address: '123 Test Street', city: 'Portland', region: 'OR', countryCode: 'US' } } });
    expect(result.statusCode).toBe(201); org = result.json().business.organizationId;
    const c = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: admin, payload: { actorType: 'customer' } });
    customer = c.json().actor.id;
  });
  afterAll(async () => { await app.close(); await pool.end(); });
  const review = (service: string, expiresAt = '2050-01-01T00:00:00Z', state = 'verified') => app.inject({
    method: 'PUT', url: `/api/admin/service-eligibility/${org}/${service}`, headers: admin,
    payload: { state, validFrom: '2020-01-01T00:00:00Z', expiresAt, evidenceReference: 'pilot-credential-record', reason: 'Credential bundle checked by Ops' } });
  async function openCase() {
    const r = await app.inject({ method: 'POST', url: '/api/demands', headers: header('customer', customer),
      payload: { domain: 'maintenance', demandType: 'wont_start', urgency: 'normal', location: { lat: 45.5, lng: -122.6 } } });
    expect(r.statusCode).toBe(201); return r.json().case;
  }
  const eligible = async (service: string) => (await pool.query('select actor_service_eligible($1,$2) as eligible', [actor, service])).rows[0].eligible;

  it('defaults newly onboarded businesses to blocked, and a three-service business becomes two when towing expires', async () => {
    expect(await eligible('tow')).toBe(false);
    for (const service of ['repair','diagnostic','tow']) expect((await review(service)).statusCode).toBe(200);
    const count = async () => (await pool.query(`select count(*)::int as n from business_service_authorizations where organization_id=$1 and actor_service_eligible($2,service)`, [org, actor])).rows[0].n;
    expect(await count()).toBe(3);
    expect((await review('tow', '2021-01-01T00:00:00Z')).statusCode).toBe(200);
    expect(await count()).toBe(2); expect(await eligible('tow')).toBe(false);
    const registry = await app.inject({ method: 'GET', url: '/api/admin/service-eligibility', headers: admin });
    expect(registry.json().authorizations.find((a: { organization_id: string; service: string }) => a.organization_id === org && a.service === 'tow').effective_state).toBe('expired');
    expect((await review('tow')).statusCode).toBe(200); expect(await count()).toBe(3);
  });

  it('rejects expiry between assignment and acceptance, preserves the job, and allows renewal then acceptance', async () => {
    const c = await openCase();
    const dispatch = await app.inject({ method: 'POST', url: '/api/admin/transport', headers: admin, payload: { caseId: c.id, transportType: 'tow' } });
    expect(dispatch.statusCode).toBe(201); const id = dispatch.json().dispatch.id;
    expect((await app.inject({ method: 'POST', url: `/api/admin/transport/${id}/assign`, headers: admin, payload: { providerActorId: actor } })).statusCode).toBe(200);
    await review('tow', '2021-01-01T00:00:00Z');
    const accept = () => app.inject({ method: 'POST', url: `/api/transport/${id}/status`, headers: header('tow', actor), payload: { status: 'accepted' } });
    expect((await accept()).statusCode).toBe(409);
    expect((await pool.query('select status from transport_dispatches where id=$1', [id])).rows[0].status).toBe('assigned');
    const registry = (await app.inject({ method: 'GET', url: '/api/admin/service-eligibility', headers: admin })).json();
    expect(registry.review.some((r: { reference_id: string }) => r.reference_id === id)).toBe(true);
    await review('tow'); expect((await accept()).statusCode).toBe(200);
    await review('tow', '2021-01-01T00:00:00Z');
    // Existing accepted work remains visible; expiry must not strand the vehicle by cancelling it.
    expect((await app.inject({ method: 'POST', url: `/api/transport/${id}/status`, headers: header('tow', actor), payload: { status: 'en_route' } })).statusCode).toBe(200);
    await review('tow');
  });

  it('cannot bypass the gate through direct offers, selected shops, parts, mobility or network handoffs', async () => {
    const c = await openCase();
    for (const service of ['repair','diagnostic','tow','parts','mobility']) await review(service, '2050-01-01T00:00:00Z', 'revoked');
    const statements: [string, unknown[]][] = [
      [`insert into matches_offers(demand_id,case_id,actor_id,rank,outcome) values($1,$2,$3,1,'accepted')`, [c.demand_id, c.id, actor]],
      [`update service_cases set selected_actor_id=$1 where id=$2`, [actor, c.id]],
      [`insert into parts_orders(case_id,supplier_actor_id) values($1,$2)`, [c.id, actor]],
      [`insert into mobility_allocations(case_id,provider_actor_id,allocation_type) values($1,$2,'loaner')`, [c.id, actor]],
      [`insert into network_handoffs(service_case_id,handoff_type,participant_actor_id,reference_type,reference_id,status) values($1,'diagnostic',$2,'manual',$3,'assigned')`, [c.id, actor, randomUUID()]]
    ];
    for (const [sql, params] of statements) await expect(pool.query(sql, params)).rejects.toMatchObject({ message: 'service_credential_ineligible' });
    for (const service of ['repair','diagnostic','tow']) await review(service);
  });

  it('rechecks an offered diagnostic job, prevents unauthorized review, and preserves login access', async () => {
    const c = await openCase();
    await pool.query(`update service_cases set state='diagnostic_pending' where id=$1`, [c.id]);
    const offer = await pool.query(`insert into matches_offers(demand_id,case_id,actor_id,rank,outcome) values($1,$2,$3,1,'offered') returning id,required_service`, [c.demand_id,c.id,actor]);
    expect(offer.rows[0].required_service).toBe('diagnostic');
    await review('diagnostic', '2021-01-01T00:00:00Z');
    await expect(pool.query(`update matches_offers set outcome='accepted' where id=$1`, [offer.rows[0].id])).rejects.toMatchObject({ message: 'service_credential_ineligible' });
    const unauthorized = await app.inject({ method: 'PUT', url: `/api/admin/service-eligibility/${org}/tow`, headers: header('tow', actor), payload: {} });
    expect(unauthorized.statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/me/service-eligibility', headers: header('tow', actor) })).statusCode).toBe(200);
    const session = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `${actor}@example.test`, password: 'Credential-pilot-123!' } });
    expect(session.statusCode).toBe(200);
    await review('diagnostic');
    await pool.query(`update matches_offers set outcome='accepted' where id=$1`, [offer.rows[0].id]);
    expect((await pool.query(`select count(*)::int as n from audit_log where action='review_service_credential' and object_id=$1`, [org])).rows[0].n).toBeGreaterThan(0);
  });

  it('serializes a credential revocation with a competing assignment', async () => {
    await review('parts'); const c = await openCase();
    const writer = await pool.connect(); const assignee = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await writer.query('begin');
      await writer.query('select id from organizations where id=$1 for update', [org]);
      await writer.query(`update business_service_authorizations set state='revoked' where organization_id=$1 and service='parts'`, [org]);
      const pid = (await assignee.query('select pg_backend_pid() as pid')).rows[0].pid;
      pending = assignee.query(`insert into parts_orders(case_id,supplier_actor_id) values($1,$2)`, [c.id,actor]).catch(error => error);
      let blocked = false;
      for (let n = 0; n < 30; n++) {
        blocked = (await writer.query('select cardinality(pg_blocking_pids($1))>0 as blocked', [pid])).rows[0].blocked;
        if (blocked) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await writer.query('commit');
      expect(await pending).toMatchObject({ message: 'service_credential_ineligible' });
    } finally {
      await writer.query('rollback').catch(() => undefined);
      await pending; writer.release(); assignee.release();
    }
    await review('parts');
  });

  it('uses the wall clock inside an already-started transaction, and never treats future credentials as current', async () => {
    await review('tow');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`update business_service_authorizations set expires_at=clock_timestamp()+interval '50 milliseconds' where organization_id=$1 and service='tow'`, [org]);
      await client.query('select pg_sleep(0.075)');
      expect((await client.query(`select actor_service_eligible($1,'tow') as eligible`, [actor])).rows[0].eligible).toBe(false);
      await client.query('rollback');
    } finally { client.release(); }
    const future = await app.inject({ method: 'PUT', url: `/api/admin/service-eligibility/${org}/tow`, headers: admin,
      payload: { state: 'verified', validFrom: '2040-01-01T00:00:00Z', expiresAt: '2050-01-01T00:00:00Z', evidenceReference: 'future-license', reason: 'Future dated credential' } });
    expect(future.statusCode).toBe(200); expect(await eligible('tow')).toBe(false); await review('tow');
  });
  it('gates standalone repair approval and first start while preserving an already-started job', async () => {
    await review('repair', '2050-01-01T00:00:00Z', 'revoked');
    const order = await pool.query(`insert into shop_repair_orders(organization_id,repair_order_number,created_by_actor_id)
      values($1,$2,$3) returning id`, [org,randomUUID(),actor]);
    const id = order.rows[0].id;
    await expect(pool.query(`update shop_repair_orders set status='approved' where id=$1`, [id])).rejects.toMatchObject({ message: 'service_credential_ineligible' });
    await review('repair'); await pool.query(`update shop_repair_orders set status='approved' where id=$1`, [id]);
    await review('repair', '2050-01-01T00:00:00Z', 'revoked');
    await expect(pool.query(`update shop_repair_orders set status='in_progress',started_at=now() where id=$1`, [id])).rejects.toMatchObject({ message: 'service_credential_ineligible' });
    await review('repair'); await pool.query(`update shop_repair_orders set status='in_progress',started_at=now() where id=$1`, [id]);
    await review('repair', '2050-01-01T00:00:00Z', 'revoked');
    await pool.query(`update shop_repair_orders set status='quality_control' where id=$1`, [id]);
    const registry = (await app.inject({ method: 'GET', url: '/api/admin/service-eligibility', headers: admin })).json();
    expect(registry.review.some((r: { reference_id: string; case_id: string | null }) => r.reference_id === id && r.case_id === null)).toBe(true);
    await review('repair');
  });

  it('requires repair credentials when a diagnostic job upgrades to physical field repair', async () => {
    const c = await openCase();
    const decision = await pool.query(`insert into field_service_decisions(case_id,created_by_actor_id,action,status,summary,operator_context)
      values($1,$2,'field_repair','proposed','Credential gate validation',$3) returning id`, [c.id,actor,JSON.stringify({operatorActorId:actor})]);
    const id = decision.rows[0].id;
    await review('repair', '2050-01-01T00:00:00Z', 'revoked');
    expect(await eligible('diagnostic')).toBe(true);
    await expect(pool.query(`update field_service_decisions set status='authorized' where id=$1`, [id])).rejects.toMatchObject({ message: 'service_credential_ineligible' });
    await review('repair'); await pool.query(`update field_service_decisions set status='authorized' where id=$1`, [id]);
    await review('repair', '2050-01-01T00:00:00Z', 'revoked');
    await expect(pool.query(`update field_service_decisions set status='in_progress' where id=$1`, [id])).rejects.toMatchObject({ message: 'service_credential_ineligible' });
    await review('repair'); await pool.query(`update field_service_decisions set status='in_progress' where id=$1`, [id]);
    await review('repair', '2050-01-01T00:00:00Z', 'revoked');
    const registry = (await app.inject({ method: 'GET', url: '/api/admin/service-eligibility', headers: admin })).json();
    expect(registry.review.some((r: { reference_id: string }) => r.reference_id === id)).toBe(true);
    await pool.query(`update field_service_decisions set status='completed' where id=$1`, [id]);
    await review('repair');
  });

});
