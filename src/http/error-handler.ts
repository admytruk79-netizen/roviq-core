import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

const conflictErrors = new Set([
  'idempotency_key_reused',
  'deferred_service_case_required_for_booking',
  'deferred_service_appointment_case_mismatch',
  'appointment_no_show_before_start'
]);

const badRequestErrors = new Set([
  'idempotency_key_too_long'
]);

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error:'validation_error', details:err.issues });
    }
    if (err instanceof Error && badRequestErrors.has(err.message)) {
      return reply.code(400).send({ error:err.message });
    }
    if (err instanceof Error && conflictErrors.has(err.message)) {
      return reply.code(409).send({ error:err.message });
    }

    const statusCode = (err as { statusCode?: number }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ error:err instanceof Error ? err.message : 'request_error' });
    }

    // A retryable Postgres deadlock/lock-timeout that reached the global handler unmapped (i.e.
    // outside a call site that already translates it, like Shop OS scheduling) is still a clean,
    // retryable conflict for the client -- not an opaque 500.
    const pgCode = (err as { code?: string }).code;
    if (pgCode === '40P01' || pgCode === '55P03') {
      return reply.code(409).send({ error:'scheduling_conflict' });
    }

    console.error('roviq_core_error',{
      correlationId:req.correlationId??req.id,
      method:req.method,
      url:req.url,
      message:err instanceof Error?err.message:String(err),
      name:err instanceof Error?err.name:'unknown_error',
      code:(err as {code?:string}).code??null
    });
    return reply.code(500).send({ error:'internal_error', requestId:req.correlationId??req.id });
  });
}
