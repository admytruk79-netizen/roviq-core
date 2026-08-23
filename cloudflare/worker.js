import { Container, getContainer } from '@cloudflare/containers';
import { env } from 'cloudflare:workers';

export class RoviqCoreContainer extends Container {
  defaultPort = 8080;
  sleepAfter = '30m';
  enableInternet = true;
  pingEndpoint = 'localhost/ready';
  envVars = {
    NODE_ENV: 'production',
    PORT: '8080',
    DATABASE_URL: env.DATABASE_URL,
    ADMIN_API_KEY: env.ADMIN_API_KEY,
    JWT_SECRET: env.JWT_SECRET,
    JWT_ISSUER: env.JWT_ISSUER || 'roviq-core',
    JWT_AUDIENCE: env.JWT_AUDIENCE || 'roviq-apps',
    ALLOW_DEV_HEADERS: 'false',
    TRIAGE_DEPLOYMENT_MODE: env.TRIAGE_DEPLOYMENT_MODE || 'shadow',
    TRIAGE_MODEL_ENDPOINT: env.TRIAGE_MODEL_ENDPOINT || '',
    TRIAGE_MODEL_API_KEY: env.TRIAGE_MODEL_API_KEY || '',
    TRIAGE_MODEL: env.TRIAGE_MODEL || '',
    TRIAGE_MODEL_PROVIDER: env.TRIAGE_MODEL_PROVIDER || '',
    TRIAGE_GATEWAY_ID: env.TRIAGE_GATEWAY_ID || '',
    TRIAGE_AUTO_CONFIDENCE_THRESHOLD: env.TRIAGE_AUTO_CONFIDENCE_THRESHOLD || '0.90'
  };
}

export default {
  async fetch(request, workerEnv) {
    const url = new URL(request.url);
    if (url.pathname === '/edge-health') {
      return Response.json({ ok: true, service: 'roviq-core-edge' });
    }
    const core = getContainer(workerEnv.ROVIQ_CORE_CONTAINER, 'primary');
    return core.fetch(request);
  }
};
