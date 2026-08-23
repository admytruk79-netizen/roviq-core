import { httpServerHandler } from 'cloudflare:node';
import { buildApp } from '../src/app.ts';

// Standard Cloudflare Worker: no Container and no changes to either Local app.
// Current Workers support Node.js HTTP server APIs, allowing Fastify to run
// through Cloudflare's HTTP server bridge.
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
