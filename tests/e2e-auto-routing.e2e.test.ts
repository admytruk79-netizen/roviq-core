import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { autoRouteNewDemand } from '../src/services/routing.js';

const ADMIN_KEY = process.env.ADMIN_API_KEY!;
function adminHeaders() { return { 'x-roviq-role': 'admin', 'x-admin-api-key': ADMIN_KEY }; }
function actorHeaders(role: string, actorId: string) { return { 'x-roviq-role': role, 'x-roviq-actor-id': actorId }; }

// Exercises autoRouteNewDemand directly (the function AUTO_ROUTE_NEW_DEMANDS gates in
// demands.ts) rather than the HTTP flag itself: env.ts parses process.env once at import time, so
// the flag can't be flipped per-file within a shared e2e run without changing every other file's
// assumption that new demands stay at 'triage' until routed manually.
describe('automatic routing engine', () => {
  let app: FastifyInstance;
  let customerActorId: string;
  let diagnosticActorId: string;

  beforeAll(async () => {
    app = await buildApp();
    await pool.query(
      `insert into routing_policies(domain_id, policy_key, version, active, configuration)
       select id, 'maintenance_default', 1, true, '{"weights":{"rating":1},"defaults":{"rating":0}}'::jsonb
       from domains where code='maintenance'
       on conflict (domain_id, policy_key, version) do update set active=true`
    );

    const customer = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'customer' } });
    customerActorId = JSON.parse(customer.body).actor.id;

    const diagnostic = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'diagnostic' } });
    diagnosticActorId = JSON.parse(diagnostic.body).actor.id;
    await pool.query(
      `insert into actor_capabilities(actor_id, capability_id) select $1, id from capabilities where capability_code = 'diagnostics'`,
      [diagnosticActorId]
    );
    await pool.query(
      `insert into capacity_snapshots(actor_id,capacity_type,quantity,start_at,end_at,source,confidence)
       values($1,'diagnostics',1,now()-interval '5 minutes',now()+interval '2 hours','e2e_auto_routing',1)`,
      [diagnosticActorId]
    );
  });

  afterAll(async () => {
    await pool.query(`update routing_policies set active=false where policy_key='maintenance_default'`);
    await pool.end();
  });

  it('moves a brand-new demand from triage to diagnostic_pending, matching the diagnostic-first default', async () => {
    const demandRes = await app.inject({
      method: 'POST', url: '/api/demands', headers: actorHeaders('customer', customerActorId),
      payload: { domain: 'maintenance', demandType: 'check_engine_light', urgency: 'normal' }
    });
    expect(demandRes.statusCode).toBe(201);
    const opened = JSON.parse(demandRes.body);
    expect(opened.case.state).toBe('triage');

    const routed = await autoRouteNewDemand({ role: 'customer', actorId: customerActorId }, opened.demand.id);
    expect(routed?.case.state).toBe('diagnostic_pending');
    expect(routed?.result.requestedCapability).toBe('diagnostics');

    const queueRes = await app.inject({ method: 'GET', url: '/api/diagnostics/me/queue', headers: actorHeaders('diagnostic', diagnosticActorId) });
    expect(queueRes.statusCode).toBe(200);
  });

  it('does nothing (case stays at triage) when no routing policy is active for the domain', async () => {
    await pool.query(`update routing_policies set active=false where policy_key='maintenance_default'`);
    try {
      const demandRes = await app.inject({
        method: 'POST', url: '/api/demands', headers: actorHeaders('customer', customerActorId),
        payload: { domain: 'maintenance', demandType: 'check_engine_light', urgency: 'normal' }
      });
      const opened = JSON.parse(demandRes.body);
      const routed = await autoRouteNewDemand({ role: 'customer', actorId: customerActorId }, opened.demand.id);
      const caseRow = await pool.query('select state from service_cases where demand_id=$1', [opened.demand.id]);
      expect(caseRow.rows[0].state).toBe('triage');
      expect(routed).toBeTruthy();
    } finally {
      await pool.query(`update routing_policies set active=true where policy_key='maintenance_default'`);
    }
  });
});
