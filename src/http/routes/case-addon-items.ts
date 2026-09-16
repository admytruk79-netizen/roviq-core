import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../middleware/principal.js';
import {
  decideAddonItem,
  flagAddonItem,
  listAddonItems,
  listCompetingQuotes,
  listOpenCompetingQuoteRequests,
  requestCompetingQuote,
  selectCompetingQuote,
  submitCompetingQuote
} from '../../services/case-addon-items.js';

function mapError(error: unknown, reply: any) {
  const message = error instanceof Error ? error.message : 'addon_item_error';
  if (message === 'case_not_found' || message === 'addon_item_not_found' || message === 'competing_quote_not_found') return reply.code(404).send({ error: message });
  if (message === 'forbidden') return reply.code(403).send({ error: message });
  if ([
    'addon_item_already_decided',
    'addon_decision_not_allowed_for_severity',
    'critical_decline_reason_required',
    'competing_quote_requires_flexible_severity',
    'addon_item_not_shoppable',
    'addon_item_not_open_for_quotes',
    'cannot_quote_own_flagged_item'
  ].includes(message)) return reply.code(409).send({ error: message });
  throw error;
}

export async function caseAddonItemRoutes(app: FastifyInstance) {
  app.post('/api/maintenance/cases/:id/addon-items', { preHandler: requireRole('admin', 'partner') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      severity: z.enum(['critical', 'urgent', 'flexible']),
      description: z.string().min(3).max(2000),
      amountMinor: z.number().int().nonnegative().optional(),
      currency: z.string().length(3).optional()
    }).parse(req.body);
    try {
      const item = await flagAddonItem(req.principal, id, body);
      return reply.code(201).send({ item });
    } catch (error) { return mapError(error, reply); }
  });

  app.get('/api/maintenance/cases/:id/addon-items', async (req, reply) => {
    const { id } = req.params as { id: string };
    try { return { items: await listAddonItems(req.principal, id) }; }
    catch (error) { return mapError(error, reply); }
  });

  app.post('/api/maintenance/cases/:id/addon-items/:itemId/decision', async (req, reply) => {
    const { id, itemId } = req.params as { id: string; itemId: string };
    const body = z.object({ decision: z.enum(['approved', 'declined_acknowledged', 'deferred']), reason: z.string().max(1000).optional() }).parse(req.body);
    try {
      const item = await decideAddonItem(req.principal, id, itemId, body.decision, body.reason);
      return { item };
    } catch (error) { return mapError(error, reply); }
  });

  app.post('/api/maintenance/cases/:id/addon-items/:itemId/request-competing-quote', async (req, reply) => {
    const { id, itemId } = req.params as { id: string; itemId: string };
    try {
      const item = await requestCompetingQuote(req.principal, id, itemId);
      return { item };
    } catch (error) { return mapError(error, reply); }
  });

  app.get('/api/maintenance/cases/:id/addon-items/:itemId/competing-quotes', async (req, reply) => {
    const { id, itemId } = req.params as { id: string; itemId: string };
    try { return { quotes: await listCompetingQuotes(req.principal, id, itemId) }; }
    catch (error) { return mapError(error, reply); }
  });

  app.post('/api/maintenance/cases/:id/addon-items/:itemId/competing-quotes/:quoteId/select', async (req, reply) => {
    const { id, itemId, quoteId } = req.params as { id: string; itemId: string; quoteId: string };
    try {
      const item = await selectCompetingQuote(req.principal, id, itemId, quoteId);
      return { item };
    } catch (error) { return mapError(error, reply); }
  });

  app.get('/api/partners/me/competing-quote-requests', { preHandler: requireRole('partner') }, async (req) => {
    return { requests: await listOpenCompetingQuoteRequests(req.principal) };
  });

  app.post('/api/addon-items/:itemId/competing-quotes', { preHandler: requireRole('partner') }, async (req, reply) => {
    const { itemId } = req.params as { itemId: string };
    const body = z.object({ amountMinor: z.number().int().nonnegative(), currency: z.string().length(3).optional(), notes: z.string().max(1000).optional() }).parse(req.body);
    try {
      const quote = await submitCompetingQuote(req.principal, itemId, body);
      return reply.code(201).send({ quote });
    } catch (error) { return mapError(error, reply); }
  });
}
