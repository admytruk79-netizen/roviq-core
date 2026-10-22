import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

const admin = { 'x-roviq-role': 'admin', 'x-admin-api-key': process.env.ADMIN_API_KEY! };
const as = (actor: string) => ({ 'x-roviq-role': 'customer', 'x-roviq-actor-id': actor });
describe('vehicle mileage and reminders', () => {
  let app: FastifyInstance;
  let customer: string;
  let other: string;
  let vehicle: string;
  beforeAll(async () => {
    app = await buildApp();
    for (const name of ['customer', 'other']) {
      const result = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: admin, payload: { actorType: 'customer' } });
      if (name === 'customer') customer = result.json().actor.id; else other = result.json().actor.id;
    }
    const result = await app.inject({ method: 'POST', url: '/api/me/vehicles', headers: as(customer),
      payload: { year: 2020, make: 'Honda', model: 'Accord', odometerValue: 10000, odometerUnit: 'miles' } });
    expect(result.statusCode).toBe(201); vehicle = result.json().vehicle.id;
  });
  afterAll(async () => { await app.close(); await pool.end(); });
  const care = () => app.inject({ method: 'GET', url: `/api/me/vehicles/${vehicle}/care`, headers: as(customer) });
  const patch = (payload: unknown) => app.inject({ method: 'PATCH', url: `/api/me/vehicles/${vehicle}`, headers: as(customer), payload });

  it('preserves readings and corrections, ignores identical retries and refuses unit-only reinterpretation', async () => {
    expect((await care()).json().history).toHaveLength(1);
    expect((await patch({ odometerUnit: 'kilometers' })).statusCode).toBe(400);
    expect((await patch({ odometerValue: 16094, odometerUnit: 'kilometers' })).statusCode).toBe(200);
    await patch({ odometerValue: 16094, odometerUnit: 'kilometers' });
    const history = (await care()).json().history;
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ value: 16094, unit: 'kilometers', source: 'reported' });
    expect(history[1]).toMatchObject({ value: 10000, unit: 'miles' });
    await patch({ odometerValue: 16093 }); // A correction retains the previous value.
    expect((await care()).json().history).toHaveLength(3);
  });

  it('compares miles with kilometres accurately, handles date-only due items and completes idempotently', async () => {
    const id = randomUUID();
    const reminder = { id, title: 'Oil service', dueOdometer: 10000, odometerUnit: 'miles' };
    const create = (payload: unknown) => app.inject({ method: 'POST', url: `/api/me/vehicles/${vehicle}/reminders`, headers: as(customer), payload });
    expect((await create(reminder)).statusCode).toBe(200);
    expect((await create(reminder)).statusCode).toBe(200);
    expect((await create({ ...reminder, title: 'Changed request' })).statusCode).toBe(409);
    expect((await care()).json().reminders).toHaveLength(1);
    expect((await care()).json().reminders[0].due).toBe(false); // 16,093 km < 10,000 mi
    await patch({ odometerValue: 16094 });
    expect((await care()).json().reminders[0].due).toBe(true);
    const complete = () => app.inject({ method: 'POST', url: `/api/me/vehicles/${vehicle}/reminders/${id}/complete`, headers: as(customer) });
    expect((await complete()).statusCode).toBe(200);
    const done = (await care()).json().reminders[0];
    await complete();
    expect((await care()).json().reminders[0]).toMatchObject({ due: false, completedAt: done.completedAt });
    expect((await create({ id: randomUUID(), title: 'Invalid calendar', dueDate: '2026-02-30' })).statusCode).toBe(400);
    expect((await create({ id: randomUUID(), title: 'Missing threshold' })).statusCode).toBe(400);
    await create({ id: randomUUID(), title: 'Date reminder', dueDate: '2020-01-01' });
    expect((await care()).json().reminders.find((r: { title: string }) => r.title === 'Date reminder').due).toBe(true);
  });

  it('hides history and reminders from another customer and unrelated actors', async () => {
    expect((await app.inject({ method: 'GET', url: `/api/me/vehicles/${vehicle}/care`, headers: as(other) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/me/vehicles/${vehicle}/reminders`, headers: as(other),
      payload: { id: randomUUID(), title: 'Intrusion', dueDate: '2027-01-01' } })).statusCode).toBe(404);
    const reminder = (await care()).json().reminders[0];
    expect((await app.inject({ method: 'POST', url: `/api/me/vehicles/${vehicle}/reminders/${reminder.id}/complete`, headers: as(other) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/me/vehicles/${vehicle}/care`, headers: { 'x-roviq-role': 'tow', 'x-roviq-actor-id': other } })).statusCode).toBe(403);
  });
});
