import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../middleware/principal.js';
import { createServiceQuote, decideServiceQuote, listServiceQuotes, presentServiceQuote } from '../../services/quotes.js';

const lineBody = z.object({
  productId:z.string().uuid().optional(),
  lineType:z.enum(['diagnostic','coordination','labor','part','transport','tax','discount','credit','other']),
  description:z.string().min(1).max(500),
  quantity:z.number().positive().optional(),
  unitAmountMinor:z.number().int().nonnegative(),
  merchantActorId:z.string().uuid().optional(),
  revenueRecognition:z.enum(['gross','net','pass_through']).optional(),
  metadata:z.record(z.unknown()).optional()
});

const createQuoteBody = z.object({
  currency:z.string().length(3).transform((value)=>value.toUpperCase()).optional(),
  expiresAt:z.string().datetime().optional(),
  lines:z.array(lineBody).min(1)
});

export async function quoteRoutes(app:FastifyInstance) {
  app.get('/api/maintenance/cases/:id/quotes', async (req, reply) => {
    const { id } = req.params as { id:string };
    try {
      return { quotes:await listServiceQuotes(req.principal,id) };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'quotes_list_failed';
      if (message === 'case_not_found') return reply.code(404).send({error:message});
      if (message === 'forbidden') return reply.code(403).send({error:message});
      throw error;
    }
  });

  app.post('/api/maintenance/cases/:id/quotes', { preHandler:requireRole('admin','partner') }, async (req, reply) => {
    const { id } = req.params as { id:string };
    const body = createQuoteBody.parse(req.body);
    try {
      const quote = await createServiceQuote(req.principal,id,body);
      return reply.code(201).send(quote);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'quote_create_failed';
      if (message === 'case_not_found' || message === 'service_plan_not_found') return reply.code(404).send({error:message});
      if (message === 'forbidden') return reply.code(403).send({error:message});
      if (['quote_requires_lines','invalid_line_amount','invalid_line_quantity','merchant_required_for_recognized_revenue'].includes(message)) return reply.code(400).send({error:message});
      throw error;
    }
  });

  app.post('/api/maintenance/cases/:id/quotes/:quoteId/present', { preHandler:requireRole('admin','partner') }, async (req, reply) => {
    const { id, quoteId } = req.params as { id:string; quoteId:string };
    try {
      return { quote:await presentServiceQuote(req.principal,id,quoteId) };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'quote_present_failed';
      if (message === 'case_not_found' || message === 'quote_not_found') return reply.code(404).send({error:message});
      if (message === 'forbidden') return reply.code(403).send({error:message});
      if (message === 'quote_not_presentable') return reply.code(409).send({error:message});
      throw error;
    }
  });

  app.post('/api/maintenance/cases/:id/quotes/:quoteId/decision', async (req, reply) => {
    const { id, quoteId } = req.params as { id:string; quoteId:string };
    const body = z.object({ decision:z.enum(['accepted','declined']) }).parse(req.body);
    try {
      return { quote:await decideServiceQuote(req.principal,id,quoteId,body.decision) };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'quote_decision_failed';
      if (message === 'case_not_found' || message === 'quote_not_found') return reply.code(404).send({error:message});
      if (message === 'forbidden') return reply.code(403).send({error:message});
      if (message === 'quote_not_awaiting_decision') return reply.code(409).send({error:message});
      throw error;
    }
  });
}
