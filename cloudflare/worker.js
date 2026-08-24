import { Container, getContainer } from '@cloudflare/containers';
import { env as workerEnv } from 'cloudflare:workers';

export class RoviqCoreContainer extends Container {
  defaultPort = 8080;
  requiredPorts = [8080];
  sleepAfter = '10m';
  enableInternet = true;
  pingEndpoint = 'localhost/health';

  envVars = {
    NODE_ENV: 'production',
    PORT: '8080',
    DATABASE_URL: workerEnv.DATABASE_URL,
    ADMIN_API_KEY: workerEnv.ADMIN_API_KEY,
    JWT_SECRET: workerEnv.JWT_SECRET,
    JWT_ISSUER: workerEnv.JWT_ISSUER || 'roviq-core',
    JWT_AUDIENCE: workerEnv.JWT_AUDIENCE || 'roviq-apps',
    ALLOW_DEV_HEADERS: 'false',
    TRIAGE_DEPLOYMENT_MODE: workerEnv.TRIAGE_DEPLOYMENT_MODE || 'shadow',
    TRIAGE_AUTO_CONFIDENCE_THRESHOLD: workerEnv.TRIAGE_AUTO_CONFIDENCE_THRESHOLD || '0.90',
    TRIAGE_MODEL_PROVIDER: 'cloudflare-workers-ai',
    TRIAGE_MODEL: workerEnv.TRIAGE_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    TRIAGE_MODEL_ENDPOINT: 'http://workers-ai.internal/v1/chat/completions',
    TRIAGE_MODEL_API_KEY: 'internal-worker-binding'
  };

  static outboundByHost = {
    'workers-ai.internal': async (request, env) => {
      try {
        const body = await request.json();
        const model = body?.model || env.TRIAGE_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
        const result = await env.AI.run(model, {
          messages: body?.messages || [],
          response_format: body?.response_format,
          temperature: body?.temperature ?? 0
        });
        return new Response(JSON.stringify({ response: result?.response ?? result }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: 'workers_ai_failed', detail: String(error?.message || error) }), {
          status: 500,
          headers: { 'content-type': 'application/json' }
        });
      }
    }
  };
}

export default {
  async fetch(request, env) {
    const core = getContainer(env.ROVIQ_CORE_CONTAINER, 'production');
    return core.fetch(request);
  }
};
