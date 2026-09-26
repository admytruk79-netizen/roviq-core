import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../middleware/principal.js';
import {
  createVehicleInquiry, updateInquiryStatus, getInquiryByTrackingToken, getInquiryForAdmin, listInquiriesForAdmin
} from '../../services/vehicle-purchase.js';

const statusEnum = z.enum(['inquired', 'contacted', 'reserved', 'financing', 'purchased', 'delivered', 'cancelled']);

export async function vehiclePurchaseRoutes(app: FastifyInstance) {
  // Public: booking a car is the zero-friction, no-login customer flow the business plan
  // describes -- a bearer token/account is not required to express interest in a specific car.
  app.post('/api/inventory/:vehicleId/book', { config: { public: true } }, async (req, reply) => {
    const { vehicleId } = z.object({ vehicleId: z.string().uuid() }).parse(req.params);
    const body = z.object({
      contactName: z.string().trim().min(1).max(200),
      contactEmail: z.string().trim().email().max(200).optional(),
      contactPhone: z.string().trim().min(7).max(40).optional(),
      notes: z.string().trim().max(2000).optional()
    }).refine((b) => b.contactEmail || b.contactPhone, { message: 'contact_method_required' }).parse(req.body);
    try {
      const inquiry = await createVehicleInquiry({ vehicleInventoryId: vehicleId, ...body });
      return reply.code(201).send({
        inquiry: { id: inquiry.id, status: inquiry.status, offerPriceCents: inquiry.offer_price_cents, currency: inquiry.currency },
        trackingToken: inquiry.tracking_token
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'inquiry_error';
      if (message === 'vehicle_not_available') return reply.code(404).send({ error: message });
      if (message === 'vehicle_price_unavailable' || message === 'contact_method_required') return reply.code(422).send({ error: message });
      throw error;
    }
  });

  // Public: order-tracking-style lookup, no login -- the tracking token itself is the credential.
  app.get('/api/inventory/track/:token', { config: { public: true } }, async (req, reply) => {
    const { token } = z.object({ token: z.string().min(1).max(200) }).parse(req.params);
    const inquiry = await getInquiryByTrackingToken(token);
    if (!inquiry) return reply.code(404).send({ error: 'inquiry_not_found' });
    return { inquiry };
  });

  app.get('/api/admin/inventory/inquiries', { preHandler: requireRole('admin') }, async (req) => {
    const query = z.object({ status: statusEnum.optional(), limit: z.coerce.number().int().positive().max(500).default(200) }).parse(req.query ?? {});
    return { inquiries: await listInquiriesForAdmin(req.principal, query) };
  });

  app.get('/api/admin/inventory/inquiries/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const inquiry = await getInquiryForAdmin(req.principal, id);
    if (!inquiry) return reply.code(404).send({ error: 'inquiry_not_found' });
    return { inquiry };
  });

  app.post('/api/admin/inventory/inquiries/:id/status', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ status: statusEnum, notes: z.string().trim().max(2000).optional() }).parse(req.body);
    try {
      const inquiry = await updateInquiryStatus(req.principal, id, body.status, body.notes);
      return { inquiry };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'inquiry_status_error';
      if (message === 'inquiry_not_found') return reply.code(404).send({ error: message });
      if (message === 'invalid_inquiry_transition') return reply.code(409).send({ error: message });
      throw error;
    }
  });
}
