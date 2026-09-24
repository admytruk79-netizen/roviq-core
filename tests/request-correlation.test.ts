import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

describe('request correlation IDs',()=>{
  let app:FastifyInstance;
  beforeAll(async()=>{app=await buildApp();});
  afterAll(async()=>{await app.close();});

  it('echoes a valid upstream request id',async()=>{
    const requestId='pilot-request-12345678';
    const response=await app.inject({
      method:'GET',url:'/health',
      headers:{'x-request-id':requestId}
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBe(requestId);
  });

  it('replaces an unsafe request id',async()=>{
    const response=await app.inject({
      method:'GET',url:'/health',
      headers:{'x-request-id':'bad id with spaces'}
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBeTruthy();
    expect(response.headers['x-request-id']).not.toBe('bad id with spaces');
  });
});
