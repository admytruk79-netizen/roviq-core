import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

const ADMIN_KEY = process.env.ADMIN_API_KEY!;
const adminHeaders = () => ({ 'x-roviq-role':'admin', 'x-admin-api-key':ADMIN_KEY });
const actorHeaders = (role:string,actorId:string) => ({ 'x-roviq-role':role, 'x-roviq-actor-id':actorId });

describe('late transport destination coherence', () => {
  let app:FastifyInstance;
  let customerActorId:string;
  let towActorId:string;

  beforeAll(async () => {
    app = await buildApp();
    const customer = await app.inject({ method:'POST', url:'/api/admin/actors', headers:adminHeaders(), payload:{ actorType:'customer' } });
    customerActorId = JSON.parse(customer.body).actor.id;
    const tow = await app.inject({ method:'POST', url:'/api/admin/actors', headers:adminHeaders(), payload:{ actorType:'tow' } });
    towActorId = JSON.parse(tow.body).actor.id;
  });

  afterAll(async () => { await pool.end(); });

  it('persists a canonical destination added after dispatch creation and allows delivery', async () => {
    const demandRes = await app.inject({
      method:'POST', url:'/api/demands', headers:actorHeaders('customer',customerActorId),
      payload:{ domain:'maintenance', demandType:'wont_start', urgency:'urgent', location:{ lat:45.52, lng:-122.68 } }
    });
    expect(demandRes.statusCode).toBe(201);
    const caseId = JSON.parse(demandRes.body).case.id as string;

    await app.inject({ method:'POST', url:`/api/maintenance/cases/${caseId}/transition`, headers:adminHeaders(), payload:{ toState:'tow_pending' } });

    const dispatchRes = await app.inject({
      method:'POST', url:'/api/admin/transport', headers:adminHeaders(),
      payload:{ caseId, transportType:'tow', pickupLocation:{ lat:45.52, lng:-122.68 } }
    });
    expect(dispatchRes.statusCode).toBe(201);
    const dispatchId = JSON.parse(dispatchRes.body).dispatch.id as string;

    await app.inject({ method:'POST', url:`/api/admin/transport/${dispatchId}/assign`, headers:adminHeaders(), payload:{ providerActorId:towActorId } });

    const before = await app.inject({ method:'GET', url:`/api/transport/${dispatchId}`, headers:actorHeaders('tow',towActorId) });
    expect(JSON.parse(before.body).dispatch.location_status).toBe('pickup_ready');

    const spatialRes = await app.inject({
      method:'PUT', url:`/api/admin/cases/${caseId}/spatial`, headers:adminHeaders(),
      payload:{ destination:{ lat:45.53, lng:-122.67, label:'Service destination' }, source:'ops_destination_assignment' }
    });
    expect(spatialRes.statusCode).toBe(200);

    const stored = await pool.query('select dropoff_location from transport_dispatches where id=$1',[dispatchId]);
    expect(stored.rows[0].dropoff_location).toMatchObject({ lat:45.53, lng:-122.67 });

    const projected = await app.inject({ method:'GET', url:`/api/transport/${dispatchId}`, headers:actorHeaders('tow',towActorId) });
    expect(JSON.parse(projected.body).dispatch.location_status).toBe('ready');

    for (const status of ['accepted','en_route','arrived','vehicle_loaded','in_transit','delivered']) {
      const res = await app.inject({ method:'POST', url:`/api/transport/${dispatchId}/status`, headers:actorHeaders('tow',towActorId), payload:{ status } });
      expect(res.statusCode).toBe(200);
    }

    const constraint = await pool.query("select status,details from case_constraints where service_case_id=$1 and projection_key='transport-readiness'",[caseId]);
    if (constraint.rowCount) {
      expect(constraint.rows[0].details.destinationReady).toBe(true);
    }
  });
});
