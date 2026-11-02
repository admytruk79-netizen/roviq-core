import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

// The two engines reading the same evidence: triage reasons over the scans recorded on a case,
// and MACRE suggests which credentials the job needs from the vehicle, description and codes.

const admin = { 'x-roviq-role': 'admin', 'x-admin-api-key': process.env.ADMIN_API_KEY! };
const as = (role: string, actorId: string) => ({ 'x-roviq-role': role, 'x-roviq-actor-id': actorId });

describe('engine synthesis: recorded scans feed triage and job requirements', () => {
  let app: FastifyInstance;
  let customer: string;
  let caseId: string;
  let vehicleId: string;
  let sourceId: string;

  async function scan(codes: string[], signals: Record<string, unknown>, minutesAgo: number) {
    await pool.query(
      `insert into vehicle_health_events(vehicle_id,source_id,service_case_id,event_type,occurred_at,dtc_codes,normalized_signals,deduplication_key,triage_state)
       values($1,$2,$3,'obd_scan',now()-($4*interval '1 minute'),$5,$6,$7,'linked_to_case')`,
      [vehicleId, sourceId, caseId, minutesAgo, codes, JSON.stringify(signals), randomUUID()]
    );
  }
  const triage = () => app.inject({ method: 'POST', url: `/api/maintenance/cases/${caseId}/triage/run`, headers: as('customer', customer), payload: { symptoms: 'Rough running and a warning light' } });

  beforeAll(async () => {
    app = await buildApp();
    customer = (await app.inject({ method: 'POST', url: '/api/admin/actors', headers: admin, payload: { actorType: 'customer' } })).json().actor.id;
    const demand = await app.inject({ method: 'POST', url: '/api/demands', headers: as('customer', customer), payload: {
      domain: 'maintenance', demandType: 'check_engine', urgency: 'normal', attributes: { description: 'A/C blows warm and the hybrid battery warning came on' } } });
    caseId = demand.json().case.id;
    vehicleId = (await pool.query(`insert into customer_vehicles(customer_actor_id,year,make,model,fuel_type) values($1,2019,'Toyota','Prius','hybrid') returning id`, [customer])).rows[0].id;
    await pool.query('update service_cases set vehicle_id=$2 where id=$1', [caseId, vehicleId]);
    sourceId = (await pool.query(`insert into connected_sources(source_type,provider_key) values('technician',$1) returning id`, [`synthesis-${randomUUID()}`])).rows[0].id;
    await scan(['P0302', 'P0A80', 'B0012'], { engineRpm: 700, coolantTemperatureC: 92 }, 30);
  });

  afterAll(async () => { await app.close(); await pool.end(); });

  it('triage cites what each recorded code means and adds its safety reading', async () => {
    const res = await triage();
    expect(res.statusCode).toBe(201);
    const { result, safetyOverride } = res.json();
    expect(safetyOverride).toBe(false);
    expect(result.evidence).toEqual(expect.arrayContaining([
      { source: 'obd_scan', statement: 'P0302: Cylinder 2 misfire detected' },
      { source: 'obd_scan', statement: 'P0A80: Replace hybrid battery pack' }
    ]));
    expect(result.safetyFlags.map((f: { code: string }) => f.code)).toEqual(expect.arrayContaining(['misfire', 'srs_restraint', 'hybrid_battery']));
    expect(result.suggestedCapabilities).toEqual(expect.arrayContaining(['diagnostics', 'repair']));
    expect(result.suggestedActions).toEqual(expect.arrayContaining([expect.objectContaining({ actionType: 'diagnostic_check' })]));
    const stored = await pool.query(`select engine_version,input_snapshot from ai_triage_assessments where id=$1`, [res.json().assessmentId]);
    expect(stored.rows[0].engine_version).toBe('triage-0.2.0');
    expect(stored.rows[0].input_snapshot.vehicleHealthEventIds).toHaveLength(1);
  });

  it('a critical scanner reading makes triage stop the vehicle, like a described emergency would', async () => {
    await scan([], { coolantTemperatureC: 121 }, 1);
    const res = (await triage()).json();
    expect(res.safetyOverride).toBe(true);
    expect(res.requiresHumanReview).toBe(true);
    expect(res.result.suggestedDrivability).toBe('non_drivable');
    expect(res.result.suggestedCapabilities).toEqual(expect.arrayContaining(['tow']));
    expect(res.result.safetyFlags).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'overheating', severity: 'critical' })]));
  });

  it('MACRE suggests the credentials this job needs, and marks those already registered', async () => {
    await pool.query(`insert into case_qualification_requirements(service_case_id,requirement_key,kind,mandatory) values($1,'hybrid_systems','training',false)`, [caseId]);
    const res = await app.inject({ method: 'GET', url: `/api/admin/qualifications/cases/${caseId}/suggested-requirements`, headers: admin });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.basedOn).toEqual({ vehicle: '2019 Toyota Prius', powertrain: 'hybrid', descriptions: expect.any(Number), dtcCodes: expect.arrayContaining(['P0302', 'P0A80', 'B0012']) });
    const by = Object.fromEntries(body.suggestions.map((s: { requirementKey: string }) => [s.requirementKey, s]));
    expect(by.ev_high_voltage).toMatchObject({ mandatory: true, registered: false, evidence: expect.arrayContaining(['P0A80']) });
    expect(by.hybrid_systems).toMatchObject({ registered: true });
    expect(by.ac_refrigerant_609).toMatchObject({ kind: 'legal_license', mandatory: true });
    expect(by.srs_restraint_systems).toMatchObject({ mandatory: false, evidence: ['B0012'] });
    expect(by.ase_a8_engine_performance).toMatchObject({ evidence: ['P0302'] });
    // Suggestions register nothing by themselves.
    expect((await pool.query('select count(*)::int as n from case_qualification_requirements where service_case_id=$1', [caseId])).rows[0].n).toBe(1);
  });

  it('suggestions are admin-only and 404 for an unknown case', async () => {
    expect((await app.inject({ method: 'GET', url: `/api/admin/qualifications/cases/${caseId}/suggested-requirements`, headers: as('customer', customer) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/api/admin/qualifications/cases/${randomUUID()}/suggested-requirements`, headers: admin })).statusCode).toBe(404);
  });
});
