import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

const ADMIN_KEY=process.env.ADMIN_API_KEY!;

describe('operational health summary',()=>{
  let app:FastifyInstance;
  beforeAll(async()=>{app=await buildApp();});
  afterAll(async()=>{await app.close();});

  it('is admin-only and exposes actionable health counters',async()=>{
    const forbidden=await app.inject({
      method:'GET',
      url:'/api/admin/operations/health-summary',
      headers:{'x-roviq-role':'customer','x-roviq-actor-id':'00000000-0000-0000-0000-000000000001'}
    });
    expect(forbidden.statusCode).toBe(403);

    const response=await app.inject({
      method:'GET',
      url:'/api/admin/operations/health-summary',
      headers:{'x-roviq-role':'admin','x-admin-api-key':ADMIN_KEY}
    });
    expect(response.statusCode).toBe(200);
    const body=response.json();
    expect(['healthy','attention','degraded']).toContain(body.status);
    expect(body.database.reachable).toBe(true);
    expect(body.database.latestMigration?.filename).toBeTruthy();
    expect(typeof body.workflow.overdueDeadlines).toBe('number');
    expect(typeof body.notifications.dead).toBe('number');
    expect(typeof body.webhooks.dead).toBe('number');
    expect(typeof body.fulfillment.recoveryRequired).toBe('number');
  });
});
