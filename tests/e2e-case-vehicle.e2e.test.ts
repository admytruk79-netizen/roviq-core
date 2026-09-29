import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

// The vehicle travels with the case: the customer picks or adds it at intake, the on-site
// diagnostic confirms it, and each actor sees only the part of it that its job needs.

const ADMIN_KEY = process.env.ADMIN_API_KEY!;
const admin = () => ({ 'x-roviq-role': 'admin', 'x-admin-api-key': ADMIN_KEY });
const as = (role: string, actorId: string) => ({ 'x-roviq-role': role, 'x-roviq-actor-id': actorId });

describe('case vehicle', () => {
  let app: FastifyInstance;
  let customer: string;
  let otherCustomer: string;
  let tow: string;
  let diagnostic: string;
  let parts: string;
  let stranger: string;
  const vinSuffix = () => Math.random().toString().slice(2, 8).padEnd(6, '0');

  async function actor(actorType: string) {
    const res = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: admin(), payload: { actorType } });
    return JSON.parse(res.body).actor.id as string;
  }

  async function addVehicle(customerId: string, payload: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: '/api/me/vehicles', headers: as('customer', customerId), payload });
  }

  async function openCase(customerId: string, extra: Record<string, unknown> = {}) {
    return app.inject({
      method: 'POST', url: '/api/demands', headers: as('customer', customerId),
      payload: { domain: 'maintenance', demandType: 'wont_start', urgency: 'normal', location: { lat: 45.5, lng: -122.6 }, ...extra }
    });
  }

  async function caseWithAllActors(vehicle: Record<string, unknown>) {
    const res = await openCase(customer, { vehicle });
    expect(res.statusCode).toBe(201);
    const caseId = JSON.parse(res.body).case.id as string;
    await app.inject({ method: 'POST', url: `/api/maintenance/cases/${caseId}/transition`, headers: admin(), payload: { toState: 'tow_pending' } });
    const dispatch = await app.inject({ method: 'POST', url: '/api/admin/transport', headers: admin(), payload: { caseId, transportType: 'tow' } });
    const dispatchId = JSON.parse(dispatch.body).dispatch.id;
    await app.inject({ method: 'POST', url: `/api/admin/transport/${dispatchId}/assign`, headers: admin(), payload: { providerActorId: tow } });
    const demandId = (await pool.query('select demand_id from service_cases where id=$1', [caseId])).rows[0].demand_id;
    await pool.query(`insert into matches_offers(demand_id,actor_id,case_id,outcome) values($1,$2,$3,'accepted')`, [demandId, diagnostic, caseId]);
    await pool.query(`insert into parts_orders(case_id,supplier_actor_id,status) values($1,$2,'supplier_assigned')`, [caseId, parts]);
    return caseId;
  }

  async function caseVehicle(caseId: string, headers: Record<string, string>) {
    const res = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}/vehicle`, headers });
    return { status: res.statusCode, vehicle: JSON.parse(res.body).vehicle };
  }

  beforeAll(async () => {
    app = await buildApp();
    customer = await actor('customer');
    otherCustomer = await actor('customer');
    tow = await actor('tow');
    diagnostic = await actor('diagnostic');
    parts = await actor('parts');
    stranger = await actor('tow');
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('customer garage', () => {
    it('saves, lists, edits and removes the customer\'s own vehicles', async () => {
      const vin = `1hgcm82633a${vinSuffix()}`;
      const created = await addVehicle(customer, { year: 2019, make: 'Honda', model: 'Accord', color: 'Blue', licensePlate: 'abc 123', vin: `${vin.slice(0, 5)}-${vin.slice(5)}` });
      expect(created.statusCode).toBe(201);
      const vehicle = JSON.parse(created.body).vehicle;
      expect(vehicle).toMatchObject({ year: 2019, make: 'Honda', model: 'Accord', vin: vin.toUpperCase(), licensePlate: 'ABC 123', verified: false });

      const list = await app.inject({ method: 'GET', url: '/api/me/vehicles', headers: as('customer', customer) });
      expect(JSON.parse(list.body).vehicles.map((v: { id: string }) => v.id)).toContain(vehicle.id);

      const edited = await app.inject({ method: 'PATCH', url: `/api/me/vehicles/${vehicle.id}`, headers: as('customer', customer), payload: { nickname: 'Daily', odometerValue: 84000 } });
      expect(JSON.parse(edited.body).vehicle).toMatchObject({ nickname: 'Daily', odometerValue: 84000 });

      const removed = await app.inject({ method: 'DELETE', url: `/api/me/vehicles/${vehicle.id}`, headers: as('customer', customer) });
      expect(removed.statusCode).toBe(200);
      const after = await app.inject({ method: 'GET', url: '/api/me/vehicles', headers: as('customer', customer) });
      expect(JSON.parse(after.body).vehicles.map((v: { id: string }) => v.id)).not.toContain(vehicle.id);
    });

    it('rejects malformed VINs, missing basics and a VIN already registered', async () => {
      expect((await addVehicle(customer, { year: 2019, make: 'Honda', model: 'Accord', vin: '1HGCM82633AIOQ123' })).statusCode).toBe(400);
      expect((await addVehicle(customer, { year: 2019, make: 'Honda', model: 'Accord', vin: 'SHORT' })).statusCode).toBe(400);
      expect((await addVehicle(customer, { make: 'Honda', model: 'Accord' })).statusCode).toBe(400);
      expect((await addVehicle(customer, { year: 2099, make: 'Honda', model: 'Accord' })).statusCode).toBe(400);
      const vin = `2T1BURHE0J${vinSuffix()}1`;
      expect((await addVehicle(customer, { year: 2018, make: 'Toyota', model: 'Corolla', vin })).statusCode).toBe(201);
      const dup = await addVehicle(otherCustomer, { year: 2018, make: 'Toyota', model: 'Corolla', vin: vin.toLowerCase() });
      expect(dup.statusCode).toBe(409);
      expect(JSON.parse(dup.body).error).toBe('vehicle_vin_conflict');
    });

    it('never lets one customer read, edit or remove another customer\'s vehicle', async () => {
      const mine = JSON.parse((await addVehicle(customer, { year: 2020, make: 'Ford', model: 'F-150' })).body).vehicle;
      const theirs = { headers: as('customer', otherCustomer) };
      expect((await app.inject({ method: 'PATCH', url: `/api/me/vehicles/${mine.id}`, ...theirs, payload: { color: 'Red' } })).statusCode).toBe(404);
      expect((await app.inject({ method: 'DELETE', url: `/api/me/vehicles/${mine.id}`, ...theirs })).statusCode).toBe(404);
      const list = await app.inject({ method: 'GET', url: '/api/me/vehicles', ...theirs });
      expect(JSON.parse(list.body).vehicles.map((v: { id: string }) => v.id)).not.toContain(mine.id);
      expect((await app.inject({ method: 'GET', url: '/api/me/vehicles', headers: as('tow', tow) })).statusCode).toBe(403);
    });
  });

  describe('intake', () => {
    it('attaches a saved vehicle, or a new one added during intake, to the case', async () => {
      const saved = JSON.parse((await addVehicle(customer, { year: 2017, make: 'Subaru', model: 'Outback', drivetrain: 'awd' })).body).vehicle;
      const withSaved = await openCase(customer, { vehicleId: saved.id });
      expect(withSaved.statusCode).toBe(201);
      const caseA = JSON.parse(withSaved.body).case.id;
      expect((await caseVehicle(caseA, as('customer', customer))).vehicle).toMatchObject({ id: saved.id, make: 'Subaru', drivetrain: 'awd' });

      const withNew = await openCase(customer, { vehicle: { year: 2021, make: 'Tesla', model: 'Model 3', fuelType: 'electric' } });
      expect(withNew.statusCode).toBe(201);
      const caseB = JSON.parse(withNew.body).case.id;
      const vehicle = (await caseVehicle(caseB, as('customer', customer))).vehicle;
      expect(vehicle).toMatchObject({ make: 'Tesla', fuelType: 'electric' });
      const garage = await app.inject({ method: 'GET', url: '/api/me/vehicles', headers: as('customer', customer) });
      expect(JSON.parse(garage.body).vehicles.map((v: { id: string }) => v.id)).toContain(vehicle.id);
    });

    it('rejects another customer\'s vehicle without creating a demand, and rejects sending both forms', async () => {
      const theirs = JSON.parse((await addVehicle(otherCustomer, { year: 2016, make: 'Mazda', model: 'CX-5' })).body).vehicle;
      const before = (await pool.query('select count(*)::int as n from demand_requests where requester_actor_id=$1', [customer])).rows[0].n;
      const res = await openCase(customer, { vehicleId: theirs.id });
      expect(res.statusCode).toBe(404);
      const after = (await pool.query('select count(*)::int as n from demand_requests where requester_actor_id=$1', [customer])).rows[0].n;
      expect(after).toBe(before);
      const both = await openCase(customer, { vehicleId: theirs.id, vehicle: { year: 2016, make: 'Mazda', model: 'CX-5' } });
      expect(both.statusCode).toBe(400);
    });

    it('still accepts a case with no vehicle, which the diagnostic can then add on site', async () => {
      const res = await openCase(customer);
      expect(res.statusCode).toBe(201);
      const caseId = JSON.parse(res.body).case.id;
      expect((await caseVehicle(caseId, as('customer', customer))).vehicle).toBeNull();
      const confirm = await app.inject({ method: 'POST', url: `/api/maintenance/cases/${caseId}/vehicle/confirm`, headers: admin(), payload: { make: 'Kia' } });
      expect(confirm.statusCode).toBe(400);
      const added = await app.inject({ method: 'POST', url: `/api/maintenance/cases/${caseId}/vehicle/confirm`, headers: admin(), payload: { year: 2015, make: 'Kia', model: 'Soul', odometerValue: 120500 } });
      expect(added.statusCode).toBe(200);
      expect(JSON.parse(added.body).vehicle).toMatchObject({ make: 'Kia', verified: true, odometerValue: 120500 });
      const garage = await app.inject({ method: 'GET', url: '/api/me/vehicles', headers: as('customer', customer) });
      expect(JSON.parse(garage.body).vehicles.some((v: { make: string }) => v.make === 'Kia')).toBe(true);
    });
  });

  describe('handoff to other actors', () => {
    const details = () => ({
      year: 2018, make: 'Chevrolet', model: 'Silverado', trim: 'LT', color: 'White', licensePlate: 'TRK 881', plateRegion: 'OR',
      drivetrain: '4wd', fuelType: 'gasoline', engine: '5.3L V8', odometerValue: 96000, vin: `3GCUKREC8J${vinSuffix()}9`
    });

    it('shows each role only what its job needs', async () => {
      const caseId = await caseWithAllActors(details());

      const towView = (await caseVehicle(caseId, as('tow', tow))).vehicle;
      expect(towView).toMatchObject({ make: 'Chevrolet', model: 'Silverado', color: 'White', licensePlate: 'TRK 881', drivetrain: '4wd' });
      expect(towView).not.toHaveProperty('vin');
      expect(towView).not.toHaveProperty('odometerValue');

      const partsView = (await caseVehicle(caseId, as('parts', parts))).vehicle;
      expect(partsView).toMatchObject({ make: 'Chevrolet', engine: '5.3L V8', drivetrain: '4wd' });
      expect(partsView.vin).toMatch(/^3GCUKREC8J/);
      expect(partsView).not.toHaveProperty('licensePlate');
      expect(partsView).not.toHaveProperty('color');
      expect(partsView).not.toHaveProperty('odometerValue');

      const diagnosticView = (await caseVehicle(caseId, as('diagnostic', diagnostic))).vehicle;
      expect(diagnosticView).toMatchObject({ odometerValue: 96000, licensePlate: 'TRK 881' });
      expect(diagnosticView.vin).toBeTruthy();

      expect((await caseVehicle(caseId, as('tow', stranger))).status).toBe(403);
      expect((await caseVehicle(caseId, as('customer', otherCustomer))).status).toBe(403);
    });

    it('puts the tow view of the vehicle on each job in the driver\'s queue', async () => {
      const caseId = await caseWithAllActors(details());
      const queue = await app.inject({ method: 'GET', url: '/api/transport/me/dispatches', headers: as('tow', tow) });
      const job = JSON.parse(queue.body).dispatches.find((d: { case_id: string }) => d.case_id === caseId);
      expect(job.vehicle).toMatchObject({ make: 'Chevrolet', color: 'White', licensePlate: 'TRK 881', drivetrain: '4wd' });
      expect(job.vehicle).not.toHaveProperty('vin');
    });
  });

  describe('on-site confirmation', () => {
    it('lets the assigned diagnostic correct and verify the vehicle, and not unrelated actors', async () => {
      const caseId = await caseWithAllActors({ year: 2014, make: 'Toyota', model: 'Camry' });
      const vin = `4T1BF1FK5E${vinSuffix()}2`;
      const confirm = await app.inject({
        method: 'POST', url: `/api/maintenance/cases/${caseId}/vehicle/confirm`, headers: as('diagnostic', diagnostic),
        payload: { year: 2015, vin, odometerValue: 142000 }
      });
      expect(confirm.statusCode).toBe(200);
      expect(JSON.parse(confirm.body).vehicle).toMatchObject({ year: 2015, vin, odometerValue: 142000, verified: true });
      const row = await pool.query('select verified_by_actor_id from customer_vehicles v join service_cases c on c.vehicle_id=v.id where c.id=$1', [caseId]);
      expect(row.rows[0].verified_by_actor_id).toBe(diagnostic);
      const events = await pool.query(`select 1 from events where aggregate_id=$1 and event_type='CASE_VEHICLE_CONFIRMED'`, [caseId]);
      expect(events.rowCount).toBe(1);

      expect((await app.inject({ method: 'POST', url: `/api/maintenance/cases/${caseId}/vehicle/confirm`, headers: as('tow', tow), payload: { color: 'Red' } })).statusCode).toBe(403);
      const otherDiagnostic = await actor('diagnostic');
      expect((await app.inject({ method: 'POST', url: `/api/maintenance/cases/${caseId}/vehicle/confirm`, headers: as('diagnostic', otherDiagnostic), payload: { color: 'Red' } })).statusCode).toBe(403);
    });

    it('lets the customer switch vehicles only until the vehicle is confirmed', async () => {
      const caseId = await caseWithAllActors({ year: 2012, make: 'Nissan', model: 'Altima' });
      const second = JSON.parse((await addVehicle(customer, { year: 2013, make: 'Nissan', model: 'Rogue' })).body).vehicle;
      const switched = await app.inject({ method: 'PUT', url: `/api/maintenance/cases/${caseId}/vehicle`, headers: as('customer', customer), payload: { vehicleId: second.id } });
      expect(switched.statusCode).toBe(200);
      expect(JSON.parse(switched.body).vehicle.model).toBe('Rogue');

      const theirs = JSON.parse((await addVehicle(otherCustomer, { year: 2013, make: 'Nissan', model: 'Leaf' })).body).vehicle;
      expect((await app.inject({ method: 'PUT', url: `/api/maintenance/cases/${caseId}/vehicle`, headers: as('customer', customer), payload: { vehicleId: theirs.id } })).statusCode).toBe(404);

      await app.inject({ method: 'POST', url: `/api/maintenance/cases/${caseId}/vehicle/confirm`, headers: as('diagnostic', diagnostic), payload: { odometerValue: 150000 } });
      const third = JSON.parse((await addVehicle(customer, { year: 2010, make: 'Nissan', model: 'Sentra' })).body).vehicle;
      const locked = await app.inject({ method: 'PUT', url: `/api/maintenance/cases/${caseId}/vehicle`, headers: as('customer', customer), payload: { vehicleId: third.id } });
      expect(locked.statusCode).toBe(409);
      expect(JSON.parse(locked.body).error).toBe('case_vehicle_confirmed');
    });

    it('drops the confirmation when the customer later changes identifying details, but not a nickname', async () => {
      const caseId = await caseWithAllActors({ year: 2011, make: 'Ford', model: 'Focus' });
      const confirmed = JSON.parse((await app.inject({ method: 'POST', url: `/api/maintenance/cases/${caseId}/vehicle/confirm`, headers: as('diagnostic', diagnostic), payload: { odometerValue: 99000 } })).body).vehicle;
      const renamed = await app.inject({ method: 'PATCH', url: `/api/me/vehicles/${confirmed.id}`, headers: as('customer', customer), payload: { nickname: 'Old Blue' } });
      expect(JSON.parse(renamed.body).vehicle.verified).toBe(true);
      const remodelled = await app.inject({ method: 'PATCH', url: `/api/me/vehicles/${confirmed.id}`, headers: as('customer', customer), payload: { model: 'Fiesta' } });
      expect(JSON.parse(remodelled.body).vehicle.verified).toBe(false);
    });
  });

  it('links a case to a customer vehicle through the database constraint (the connected-device path relied on this)', async () => {
    const vehicle = JSON.parse((await addVehicle(customer, { year: 2022, make: 'Hyundai', model: 'Ioniq 5' })).body).vehicle;
    const caseId = JSON.parse((await openCase(customer)).body).case.id;
    await expect(pool.query('update service_cases set vehicle_id=$2 where id=$1', [caseId, vehicle.id])).resolves.toBeTruthy();
  });
});
