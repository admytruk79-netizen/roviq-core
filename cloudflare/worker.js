import { httpServerHandler } from 'cloudflare:node';
import { buildApp } from '../src/app.js';

// Cloudflare Workers (compatibility date >= 2026-08-04) provides Node.js
// compatibility and the Node HTTP server bridge. Fastify can therefore run
// directly in the Worker without a paid Cloudflare Container.
const app = await buildApp();
await app.listen({ port: 8080 });

const handler = httpServerHandler({ port: 8080 });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/edge-health') {
      return Response.json({ ok: true, service: 'roviq-core-edge', runtime: 'worker' });
    }
    return handler.fetch(request, env, ctx);
  }
};
