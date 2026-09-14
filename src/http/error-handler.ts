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
  app.setErrorHandler((err, _req, reply) => {
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

    console.error('roviq_core_error', err);
    return reply.code(500).send({ error:'internal_error' });
  });
}
