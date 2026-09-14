import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { coreRoutes } from './routes/core.js';
import { demandRoutes } from './routes/demands.js';
import { caseRoutes } from './routes/cases.js';
import { exceptionRoutes } from './routes/exceptions.js';
import { coherenceRoutes } from './routes/coherence.js';
import { fieldServiceRoutes } from './routes/field-service.js';
import { meRoutes } from './routes/me.js';
import { servicePlanRoutes } from './routes/service-plans.js';
import { quoteRoutes } from './routes/quotes.js';
import { analyticsRoutes } from './routes/analytics.js';
import { commerceRoutes } from './routes/commerce.js';
import { partnerRoutes } from './routes/partners.js';
import { adminRoutes } from './routes/admin.js';
import { routingRoutes } from './routes/routing.js';
import { diagnosticRoutes } from './routes/diagnostics.js';
import { transportRoutes } from './routes/transport.js';
import { mobilityRoutes } from './routes/mobility.js';
import { partsRoutes } from './routes/parts.js';
import { paymentRoutes } from './routes/payments.js';
import { paymentWebhookRoutes } from './routes/payment-webhooks.js';
import { notificationRoutes } from './routes/notifications.js';
import { triageRoutes } from './routes/triage.js';
import { integrationRoutes } from './routes/integrations.js';
import { shopOsRoutes } from './routes/shop-os.js';
import { shopOsDeferredAppointmentChoiceRoutes } from './routes/shop-os-deferred-appointment-choices.js';
import { shopOsFloorRoutes } from './routes/shop-os-floor.js';
import { localRoutes } from './routes/local.js';
import { triageEvaluationRoutes } from './routes/triage-evaluation.js';

type RoutePlugin = FastifyPluginAsync | ((app: FastifyInstance) => Promise<void>);

type RouteModule = {
  name: string;
  plugins: RoutePlugin[];
};

const routeModules: RouteModule[] = [
  { name: 'platform', plugins: [authRoutes, coreRoutes, meRoutes] },
  { name: 'case-lifecycle', plugins: [demandRoutes, caseRoutes, exceptionRoutes, servicePlanRoutes, quoteRoutes] },
  { name: 'coordination', plugins: [routingRoutes, triageRoutes, triageEvaluationRoutes, coherenceRoutes] },
  { name: 'service-operations', plugins: [diagnosticRoutes, fieldServiceRoutes, transportRoutes, mobilityRoutes, partsRoutes] },
  { name: 'shop-os', plugins: [shopOsRoutes, shopOsDeferredAppointmentChoiceRoutes, shopOsFloorRoutes] },
  { name: 'financial-and-communications', plugins: [paymentWebhookRoutes, paymentRoutes, commerceRoutes, notificationRoutes] },
  { name: 'integration-and-observability', plugins: [integrationRoutes, analyticsRoutes, localRoutes] },
  { name: 'actor-surfaces', plugins: [partnerRoutes, adminRoutes] }
];

export async function registerPublicRoutes(app: FastifyInstance) {
  await app.register(healthRoutes);
}

export async function registerApplicationRoutes(app: FastifyInstance) {
  for (const module of routeModules) {
    for (const plugin of module.plugins) await app.register(plugin);
  }
}

export function registeredRouteModules() {
  return routeModules.map(({ name, plugins }) => ({ name, routeCount: plugins.length }));
}
