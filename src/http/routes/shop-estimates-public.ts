import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { confirmCustomerCheckoutByLink, decideCustomerEstimate, startCustomerCheckout, viewCustomerEstimate } from '../../services/shop-customer-links.js';
import { checkoutPortalJob, confirmPortalCheckout, decidePortalJob, viewPortal } from '../../services/shop-customer-portal.js';

// Public endpoints behind a walk-in customer's private estimate link. The token in the path is the
// only credential; it opens one repair order, expires, and is replaced when the shop sends a new one.

const token = z.object({ token: z.string().min(20).max(64) });
const limited = (max: number) => ({ config: { public: true, rateLimit: { max, timeWindow: '1 minute' } } });

export async function shopEstimatePublicRoutes(app: FastifyInstance) {
  app.get('/api/public/shop-estimates/:token', limited(60), async (req) => viewCustomerEstimate(token.parse(req.params).token));

  app.post('/api/public/shop-estimates/:token/decision', limited(20), async (req) => {
    const body = z.object({ decisions: z.array(z.object({ lineId: z.string().uuid(), decision: z.enum(['approved', 'declined']) })).min(1).max(200) }).parse(req.body);
    return decideCustomerEstimate(token.parse(req.params).token, body.decisions);
  });

  app.post('/api/public/shop-estimates/:token/checkout', limited(10), async (req) =>
    startCustomerCheckout(token.parse(req.params).token, typeof req.headers.origin === 'string' ? req.headers.origin : undefined));

  app.post('/api/public/shop-estimates/:token/confirm', limited(20), async (req) => {
    const body = z.object({ sessionId: z.string().min(5).max(255) }).parse(req.body);
    return confirmCustomerCheckoutByLink(token.parse(req.params).token, body.sessionId);
  });

  // The shop's customer portal: the token opens one customer's jobs at one shop.
  const job = z.object({ token: z.string().min(20).max(64), jobId: z.string().uuid() });
  app.get('/api/public/shop-portal/:token', limited(60), async (req) => viewPortal(token.parse(req.params).token));

  app.post('/api/public/shop-portal/:token/jobs/:jobId/decision', limited(20), async (req) => {
    const p = job.parse(req.params);
    const body = z.object({ decisions: z.array(z.object({ lineId: z.string().uuid(), decision: z.enum(['approved', 'declined']) })).min(1).max(200) }).parse(req.body);
    return decidePortalJob(p.token, p.jobId, body.decisions);
  });

  app.post('/api/public/shop-portal/:token/jobs/:jobId/checkout', limited(10), async (req) => {
    const p = job.parse(req.params);
    return checkoutPortalJob(p.token, p.jobId, typeof req.headers.origin === 'string' ? req.headers.origin : undefined);
  });

  app.post('/api/public/shop-portal/:token/jobs/:jobId/confirm', limited(20), async (req) => {
    const p = job.parse(req.params);
    const body = z.object({ sessionId: z.string().min(5).max(255) }).parse(req.body);
    return confirmPortalCheckout(p.token, p.jobId, body.sessionId);
  });
}
