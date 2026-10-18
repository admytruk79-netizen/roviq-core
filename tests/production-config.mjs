export const EDGE_URL = process.env.EDGE_URL ?? 'https://roviq-core.admytruk79.workers.dev';
export const ACTOR_URL = (process.env.ACTOR_URL ?? 'https://roviq-service.pages.dev').replace(/\/$/, '');
export const APPS = Object.freeze({
  customer: process.env.CUSTOMER_URL ?? 'https://roviq-core-customer.pages.dev',
  actor: ACTOR_URL
});
export const PORTALS = Object.freeze({
  customer: APPS.customer,
  diagnostic: process.env.DIAGNOSTIC_URL ?? `${ACTOR_URL}/diagnostic/`,
  partner: process.env.PARTNER_URL ?? `${ACTOR_URL}/partner/`,
  parts: process.env.PARTS_URL ?? `${ACTOR_URL}/parts/`,
  tow: process.env.TOW_URL ?? `${ACTOR_URL}/tow/`,
  ops: process.env.OPS_URL ?? `${ACTOR_URL}/ops/`
});
export const LAUNCHER_URL = ACTOR_URL;
