import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

const ADMIN_KEY = process.env.ADMIN_API_KEY!;

function adminHeaders() {
  return { 'x-roviq-role': 'admin', 'x-admin-api-key': ADMIN_KEY };
}
function actorHeaders(role: string, actorId: string) {
  return { 'x-roviq-role': role, 'x-roviq-actor-id': actorId };
}

describe('commerce catalog (commercial products / price books) admin plumbing', () => {
  let app: FastifyInstance;
  let customerActorId: string;

  beforeAll(async () => {
    app = await buildApp();
    const customer = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'customer' } });
    customerActorId = JSON.parse(customer.body).actor.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('is admin-only for every write and list route', async () => {
    for (const call of [
      { method: 'POST' as const, url: '/api/admin/commerce/products', payload: { code: 'x', productType: 'transport', name: 'x' } },
      { method: 'GET' as const, url: '/api/admin/commerce/products' },
      { method: 'POST' as const, url: '/api/admin/commerce/price-books', payload: { code: 'x', audienceType: 'customer', startsAt: new Date().toISOString() } },
      { method: 'GET' as const, url: '/api/admin/commerce/price-books' }
    ]) {
      const res = await app.inject({ ...call, headers: actorHeaders('customer', customerActorId) });
      expect(res.statusCode).toBe(403);
    }
  });

  it('creates a product, a price book, and an item, and lists them back -- with no price ever hardcoded by the platform itself', async () => {
    const productRes = await app.inject({
      method: 'POST', url: '/api/admin/commerce/products', headers: adminHeaders(),
      payload: { code: `case-coordination-${Date.now()}`, productType: 'case_coordination', name: 'AI-direct case coordination fee' }
    });
    expect(productRes.statusCode).toBe(201);
    const product = JSON.parse(productRes.body).product;
    expect(product.active).toBe(true);

    const listProductsRes = await app.inject({ method: 'GET', url: '/api/admin/commerce/products', headers: adminHeaders() });
    expect(listProductsRes.statusCode).toBe(200);
    expect(JSON.parse(listProductsRes.body).products.some((p: { id: string }) => p.id === product.id)).toBe(true);

    const priceBookRes = await app.inject({
      method: 'POST', url: '/api/admin/commerce/price-books', headers: adminHeaders(),
      payload: { code: `portland-pilot-${Date.now()}`, audienceType: 'customer', startsAt: new Date().toISOString() }
    });
    expect(priceBookRes.statusCode).toBe(201);
    const priceBook = JSON.parse(priceBookRes.body).priceBook;

    const listPriceBooksRes = await app.inject({ method: 'GET', url: '/api/admin/commerce/price-books', headers: adminHeaders() });
    expect(JSON.parse(listPriceBooksRes.body).priceBooks.some((b: { id: string }) => b.id === priceBook.id)).toBe(true);

    // The unit amount is entirely caller-supplied -- this test's 3900 is a placeholder for the
    // e2e assertion, not a number the platform defaults to or invents on its own.
    const itemRes = await app.inject({
      method: 'POST', url: `/api/admin/commerce/price-books/${priceBook.id}/items`, headers: adminHeaders(),
      payload: { productId: product.id, unitAmountMinor: 3900 }
    });
    expect(itemRes.statusCode).toBe(201);
    const item = JSON.parse(itemRes.body).item;
    expect(Number(item.unit_amount_minor)).toBe(3900);
    expect(item.billing_interval).toBe('one_time');

    const listItemsRes = await app.inject({ method: 'GET', url: `/api/admin/commerce/price-books/${priceBook.id}/items`, headers: adminHeaders() });
    expect(listItemsRes.statusCode).toBe(200);
    const items = JSON.parse(listItemsRes.body).items;
    expect(items).toHaveLength(1);
    expect(items[0].product_code).toBe(product.code);
  });

  it('rejects a duplicate product code, an item for a nonexistent price book or product, and an invalid unit amount', async () => {
    const code = `duplicate-check-${Date.now()}`;
    const firstRes = await app.inject({
      method: 'POST', url: '/api/admin/commerce/products', headers: adminHeaders(),
      payload: { code, productType: 'parts', name: 'first' }
    });
    expect(firstRes.statusCode).toBe(201);
    const dupeRes = await app.inject({
      method: 'POST', url: '/api/admin/commerce/products', headers: adminHeaders(),
      payload: { code, productType: 'parts', name: 'second' }
    });
    expect(dupeRes.statusCode).toBe(409);

    const missingBookRes = await app.inject({
      method: 'POST', url: `/api/admin/commerce/price-books/00000000-0000-0000-0000-000000000000/items`, headers: adminHeaders(),
      payload: { productId: JSON.parse(firstRes.body).product.id, unitAmountMinor: 100 }
    });
    expect(missingBookRes.statusCode).toBe(404);

    const priceBookRes = await app.inject({
      method: 'POST', url: '/api/admin/commerce/price-books', headers: adminHeaders(),
      payload: { code: `book-${Date.now()}`, audienceType: 'partner', startsAt: new Date().toISOString() }
    });
    const priceBookId = JSON.parse(priceBookRes.body).priceBook.id;

    const missingProductRes = await app.inject({
      method: 'POST', url: `/api/admin/commerce/price-books/${priceBookId}/items`, headers: adminHeaders(),
      payload: { productId: '00000000-0000-0000-0000-000000000000', unitAmountMinor: 100 }
    });
    expect(missingProductRes.statusCode).toBe(404);

    const invalidAmountRes = await app.inject({
      method: 'POST', url: `/api/admin/commerce/price-books/${priceBookId}/items`, headers: adminHeaders(),
      payload: { productId: JSON.parse(firstRes.body).product.id, unitAmountMinor: -1 }
    });
    expect(invalidAmountRes.statusCode).toBe(400);
  });
});
