import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

const ADMIN_KEY = process.env.ADMIN_API_KEY!;

function adminHeaders() {
  return { 'x-roviq-role': 'admin', 'x-admin-api-key': ADMIN_KEY };
}
function actorHeaders(role: string, actorId: string) {
  return { 'x-roviq-role': role, 'x-roviq-actor-id': actorId };
}

describe('connected vehicle ingestion and warranty coordination', () => {
  let app: FastifyInstance;
  let customerActorId: string;
  let strangerActorId: string;
  let vehicleId: string;
  let readerSourceId: string;

  beforeAll(async () => {
    app = await buildApp();

    const customer = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'customer' } });
    customerActorId = JSON.parse(customer.body).actor.id;

    const stranger = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'customer' } });
    strangerActorId = JSON.parse(stranger.body).actor.id;

    const vehicle = await pool.query(
      `insert into customer_vehicles(customer_actor_id,vin,year,make,model,trim) values($1,'1HGCM82633A004352',2020,'Honda','Accord','EX') returning id`,
      [customerActorId]
    );
    vehicleId = vehicle.rows[0].id;

    const source = await app.inject({
      method: 'POST', url: '/api/admin/connected/sources', headers: adminHeaders(),
      payload: { sourceType: 'roviq_reader', providerKey: 'roviq-reader-v1' }
    });
    readerSourceId = JSON.parse(source.body).source.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  async function enroll(externalDeviceId: string) {
    const res = await app.inject({
      method: 'POST', url: '/api/connected/enrollments', headers: actorHeaders('customer', customerActorId),
      payload: { vehicleId, sourceId: readerSourceId, externalDeviceId, consentVersion: 'v1' }
    });
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.body).enrollment.id as string;
  }

  it('enrolls a device, ingests a health event idempotently, and isolates it from an unrelated customer', async () => {
    const enrollmentId = await enroll('dev-baseline');

    const occurredAt = new Date().toISOString();
    const first = await app.inject({
      method: 'POST', url: '/api/connected/health-events', headers: actorHeaders('customer', customerActorId),
      payload: {
        vehicleId, sourceId: readerSourceId, enrollmentId, eventType: 'dtc_reported',
        severity: 'advisory', safetyState: 'review_required', occurredAt, dtcCodes: ['P0171'], normalizedSignals: { fuelTrim: 12 }
      }
    });
    expect(first.statusCode).toBe(201);
    const event = JSON.parse(first.body);
    expect(event.deduplicated).toBe(false);
    expect(event.event.severity).toBe('advisory');
    expect(event.event.safety_override).toBe(false);
    expect(event.event.requires_human_review).toBe(false);

    // Same source, same content, same occurredAt -- a retried delivery must not create a second row.
    const duplicate = await app.inject({
      method: 'POST', url: '/api/connected/health-events', headers: actorHeaders('customer', customerActorId),
      payload: {
        vehicleId, sourceId: readerSourceId, enrollmentId, eventType: 'dtc_reported',
        severity: 'advisory', safetyState: 'review_required', occurredAt, dtcCodes: ['P0171'], normalizedSignals: { fuelTrim: 12 }
      }
    });
    expect(duplicate.statusCode).toBe(200);
    expect(JSON.parse(duplicate.body).deduplicated).toBe(true);
    expect(JSON.parse(duplicate.body).event.id).toBe(event.event.id);

    const list = await app.inject({ method: 'GET', url: `/api/connected/vehicles/${vehicleId}/health-events`, headers: actorHeaders('customer', customerActorId) });
    expect(list.statusCode).toBe(200);
    expect(JSON.parse(list.body).events.some((e: { id: string }) => e.id === event.event.id)).toBe(true);

    const strangerList = await app.inject({ method: 'GET', url: `/api/connected/vehicles/${vehicleId}/health-events`, headers: actorHeaders('customer', strangerActorId) });
    expect(strangerList.statusCode).toBe(403);
  });

  it('rejects a reader-class source submitting a health event with no enrollment', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/connected/health-events', headers: actorHeaders('customer', customerActorId),
      payload: {
        vehicleId, sourceId: readerSourceId, eventType: 'dtc_reported', severity: 'advisory', safetyState: 'review_required',
        occurredAt: new Date().toISOString(), dtcCodes: ['P0300'], normalizedSignals: {}
      }
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('enrollment_required');
  });

  it('overrides a source that under-reports a deterministically critical DTC, regardless of what it claims', async () => {
    const enrollmentId = await enroll('dev-misfire');

    // P0300 (random/multiple cylinder misfire) is one of the deterministic-critical codes -- the
    // source claims this is routine, but Core must not take that claim at face value.
    const res = await app.inject({
      method: 'POST', url: '/api/connected/health-events', headers: actorHeaders('customer', customerActorId),
      payload: {
        vehicleId, sourceId: readerSourceId, enrollmentId, eventType: 'dtc_reported',
        severity: 'info', safetyState: 'unknown', occurredAt: new Date().toISOString(),
        dtcCodes: ['P0300'], normalizedSignals: {}
      }
    });
    expect(res.statusCode).toBe(201);
    const event = JSON.parse(res.body).event;
    expect(event.severity).toBe('critical');
    expect(event.safety_state).toBe('stop_driving');
    expect(event.safety_override).toBe(true);
    expect(event.safety_override_reason).toContain('random_multiple_misfire');
    expect(event.requires_human_review).toBe(true);
    // The source's own (understated) claim is preserved for audit, not silently discarded.
    expect(event.metadata.reportedSeverity).toBe('info');
    expect(event.metadata.reportedSafetyState).toBe('unknown');
  });

  it('overrides on free-text safety language when the DTC list alone would not have triggered it', async () => {
    const enrollmentId = await enroll('dev-brake-text');

    const res = await app.inject({
      method: 'POST', url: '/api/connected/health-events', headers: actorHeaders('customer', customerActorId),
      payload: {
        vehicleId, sourceId: readerSourceId, enrollmentId, eventType: 'operator_note',
        severity: 'warning', safetyState: 'review_required', occurredAt: new Date().toISOString(),
        dtcCodes: [], normalizedSignals: { note: 'driver reports brake failure on last trip' }
      }
    });
    expect(res.statusCode).toBe(201);
    const event = JSON.parse(res.body).event;
    expect(event.safety_override).toBe(true);
    expect(event.safety_state).toBe('stop_driving');
    expect(event.safety_override_reason).toContain('brake_failure');
  });

  it('does not flag a routine, honestly-reported event, and matches an already-honest critical report without discrepancy', async () => {
    const enrollmentId = await enroll('dev-honest');

    const routine = await app.inject({
      method: 'POST', url: '/api/connected/health-events', headers: actorHeaders('customer', customerActorId),
      payload: {
        vehicleId, sourceId: readerSourceId, enrollmentId, eventType: 'mileage_update',
        severity: 'info', safetyState: 'unknown', occurredAt: new Date().toISOString(), dtcCodes: [], normalizedSignals: { odometer: 42000 }
      }
    });
    expect(routine.statusCode).toBe(201);
    const routineEvent = JSON.parse(routine.body).event;
    expect(routineEvent.safety_override).toBe(false);
    expect(routineEvent.severity).toBe('info');
    expect(routineEvent.safety_state).toBe('unknown');
    expect(routineEvent.requires_human_review).toBe(false);

    // The source already honestly reports critical/stop_driving for a genuinely critical code --
    // Core's independent check still runs and agrees, rather than skipping verification because
    // the client happened to self-report correctly.
    const honestCritical = await app.inject({
      method: 'POST', url: '/api/connected/health-events', headers: actorHeaders('customer', customerActorId),
      payload: {
        vehicleId, sourceId: readerSourceId, enrollmentId, eventType: 'dtc_reported',
        severity: 'critical', safetyState: 'stop_driving', occurredAt: new Date().toISOString(),
        dtcCodes: ['P0217'], normalizedSignals: {}
      }
    });
    expect(honestCritical.statusCode).toBe(201);
    const honestEvent = JSON.parse(honestCritical.body).event;
    expect(honestEvent.safety_override).toBe(true);
    expect(honestEvent.severity).toBe('critical');
    expect(honestEvent.safety_state).toBe('stop_driving');
    expect(honestEvent.metadata.reportedSeverity).toBe('critical');
    expect(honestEvent.metadata.reportedSafetyState).toBe('stop_driving');
  });

  it('raises a critical case exception when a safety override fires on an event linked to a service case', async () => {
    const enrollmentId = await enroll('dev-linked-case');

    const demandRes = await app.inject({
      method: 'POST', url: '/api/demands', headers: actorHeaders('customer', customerActorId),
      payload: { domain: 'maintenance', demandType: 'wont_start', urgency: 'normal' }
    });
    expect(demandRes.statusCode).toBe(201);
    const caseId = JSON.parse(demandRes.body).case.id as string;

    const res = await app.inject({
      method: 'POST', url: '/api/connected/health-events', headers: actorHeaders('customer', customerActorId),
      payload: {
        vehicleId, sourceId: readerSourceId, enrollmentId, serviceCaseId: caseId, eventType: 'dtc_reported',
        severity: 'advisory', safetyState: 'review_required', occurredAt: new Date().toISOString(),
        dtcCodes: ['P0A05'], normalizedSignals: {}
      }
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).event.safety_override).toBe(true);

    // The case must have inherited the vehicle link...
    const caseVehicle = await pool.query('select connected_vehicle_id from service_cases where id=$1', [caseId]);
    expect(caseVehicle.rows[0].connected_vehicle_id).toBe(vehicleId);

    // ...and the override must be a real, actionable item in the exception queue, not just a flag
    // on the event row nobody is forced to look at.
    const exceptionsRes = await app.inject({ method: 'GET', url: '/api/admin/exceptions', headers: adminHeaders() });
    expect(exceptionsRes.statusCode).toBe(200);
    const exceptions = JSON.parse(exceptionsRes.body).exceptions as any[];
    const raised = exceptions.find((e) => e.case_id === caseId && e.exception_code === 'VEHICLE_HEALTH_SAFETY_OVERRIDE');
    expect(raised).toBeTruthy();
    expect(raised.severity).toBe('critical');
    expect(raised.state).toBe('open');

    const timelineRes = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}/timeline`, headers: adminHeaders() });
    const timelineEvents = JSON.parse(timelineRes.body).timeline.map((e: { event_type: string }) => e.event_type);
    expect(timelineEvents).toEqual(expect.arrayContaining(['VEHICLE_HEALTH_EVENT_LINKED', 'VEHICLE_HEALTH_SAFETY_OVERRIDE']));
  });

  it('records and lists a warranty coverage for the vehicle, scoped to its owner', async () => {
    const create = await app.inject({
      method: 'POST', url: `/api/connected/vehicles/${vehicleId}/warranty-coverages`, headers: actorHeaders('customer', customerActorId),
      payload: { coverageType: 'factory', coverageStatus: 'active', endsAt: '2028-01-01' }
    });
    expect(create.statusCode).toBe(201);
    expect(JSON.parse(create.body).coverage.source).toBe('customer');

    const list = await app.inject({ method: 'GET', url: `/api/connected/vehicles/${vehicleId}/warranty-coverages`, headers: actorHeaders('customer', customerActorId) });
    expect(list.statusCode).toBe(200);
    expect(JSON.parse(list.body).coverages.length).toBeGreaterThan(0);

    const strangerRead = await app.inject({ method: 'GET', url: `/api/connected/vehicles/${vehicleId}/warranty-coverages`, headers: actorHeaders('customer', strangerActorId) });
    expect(strangerRead.statusCode).toBe(403);
  });
});
