import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest { correlationId:string }
}

const SAFE_REQUEST_ID=/^[A-Za-z0-9._:-]{8,128}$/;

export function registerRequestContext(app:FastifyInstance){
  app.addHook('onRequest',async(req,reply)=>{
    const incoming=req.headers['x-request-id'];
    const correlationId=typeof incoming==='string'&&SAFE_REQUEST_ID.test(incoming)
      ? incoming
      : randomUUID();
    req.correlationId=correlationId;
    reply.header('x-request-id',correlationId);
  });
}
