import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

const ADMIN_KEY = process.env.ADMIN_API_KEY!;
const adminHeaders = () => ({ 'x-roviq-role':'admin', 'x-admin-api-key':ADMIN_KEY });

describe('exception route validation', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('returns 400 instead of leaking a database UUID error for malformed exception state ids', async () => {
    const res = await app.inject({
      method:'POST',
      url:'/api/admin/exceptions/not-a-uuid/state',
      headers:adminHeaders(),
      payload:{state:'acknowledged'}
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({error:'invalid_exception_id'});
  });

  it('returns 400 instead of leaking a database UUID error for malformed exception assignment ids', async () => {
    const res = await app.inject({
      method:'PUT',
      url:'/api/admin/exceptions/not-a-uuid/assignment',
      headers:adminHeaders(),
      payload:{ownerActorId:null}
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({error:'invalid_exception_id'});
  });
});
