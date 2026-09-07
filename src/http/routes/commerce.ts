import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../middleware/principal.js';
import { addPriceBookItem, createCommercialProduct, createPriceBook, listCommercialProducts, listPriceBookItems, listPriceBooks } from '../../services/commerce.js';

const productBody = z.object({
  code:z.string().min(1).max(100),
  productType:z.enum(['partner_subscription','diagnostic_coordination','case_coordination','transport','parts','customer_membership','prepaid_plan','enterprise']),
  name:z.string().min(1).max(200),
  description:z.string().max(2000).optional(),
  active:z.boolean().optional(),
  attributes:z.record(z.unknown()).optional()
});

const priceBookBody = z.object({
  code:z.string().min(1).max(100),
  marketId:z.string().uuid().optional(),
  audienceType:z.enum(['customer','partner','fleet','enterprise']),
  currency:z.string().length(3).optional(),
  startsAt:z.string().datetime(),
  endsAt:z.string().datetime().optional(),
  active:z.boolean().optional()
});

const priceBookItemBody = z.object({
  productId:z.string().uuid(),
  unitAmountMinor:z.number().int().nonnegative(),
  billingInterval:z.enum(['one_time','monthly','annual']).optional(),
  conditions:z.record(z.unknown()).optional()
});

export async function commerceRoutes(app:FastifyInstance) {
  app.post('/api/admin/commerce/products', { preHandler:requireRole('admin') }, async (req, reply) => {
    const body = productBody.parse(req.body);
    try {
      return reply.code(201).send({ product:await createCommercialProduct(req.principal,body) });
    } catch (error) {
      if ((error as { code?:string }).code === '23505') return reply.code(409).send({ error:'commercial_product_code_taken' });
      throw error;
    }
  });

  app.get('/api/admin/commerce/products', { preHandler:requireRole('admin') }, async (req) => {
    const query = z.object({ activeOnly:z.enum(['true','false']).optional() }).parse(req.query ?? {});
    return { products:await listCommercialProducts(query.activeOnly !== 'false') };
  });

  app.post('/api/admin/commerce/price-books', { preHandler:requireRole('admin') }, async (req, reply) => {
    const body = priceBookBody.parse(req.body);
    try {
      return reply.code(201).send({ priceBook:await createPriceBook(req.principal,body) });
    } catch (error) {
      if ((error as { code?:string }).code === '23505') return reply.code(409).send({ error:'price_book_code_and_start_taken' });
      throw error;
    }
  });

  app.get('/api/admin/commerce/price-books', { preHandler:requireRole('admin') }, async (req) => {
    const query = z.object({ activeOnly:z.enum(['true','false']).optional() }).parse(req.query ?? {});
    return { priceBooks:await listPriceBooks(query.activeOnly !== 'false') };
  });

  app.post('/api/admin/commerce/price-books/:id/items', { preHandler:requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id:string };
    const body = priceBookItemBody.parse(req.body);
    try {
      return reply.code(201).send({ item:await addPriceBookItem(req.principal,id,body) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'price_book_item_create_failed';
      if (['price_book_not_found','commercial_product_not_found'].includes(message)) return reply.code(404).send({ error:message });
      if (message === 'invalid_unit_amount') return reply.code(400).send({ error:message });
      throw error;
    }
  });

  app.get('/api/admin/commerce/price-books/:id/items', { preHandler:requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id:string };
    try {
      return { items:await listPriceBookItems(id) };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'price_book_items_list_failed';
      if (message === 'price_book_not_found') return reply.code(404).send({ error:message });
      throw error;
    }
  });
}
