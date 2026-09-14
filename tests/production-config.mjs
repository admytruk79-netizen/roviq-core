export const EDGE_URL = process.env.EDGE_URL ?? 'https://roviq-core.admytruk79.workers.dev';

export const PORTALS = Object.freeze({
  customer: process.env.CUSTOMER_URL ?? 'https://roviq-core-customer.pages.dev',
  diagnostic: process.env.DIAGNOSTIC_URL ?? 'https://roviq-diagnostic-net.pages.dev',
  partner: process.env.PARTNER_URL ?? 'https://roviq-partner.pages.dev',
  parts: process.env.PARTS_URL ?? 'https://roviq-parts-net.pages.dev',
  tow: process.env.TOW_URL ?? 'https://roviq-tow-net.pages.dev',
  ops: process.env.OPS_URL ?? 'https://roviq-ops.pages.dev'
});

export const LAUNCHER_URL = process.env.LAUNCHER_URL ?? 'https://roviq-portals.pages.dev';
