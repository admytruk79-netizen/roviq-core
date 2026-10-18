// Compatibility for previously issued checkout links. No tokens cross origins.
export function legacyCustomerReturn(search: string): string | null {
  const params = new URLSearchParams(search);
  if (params.get('open') !== 'customer') return null;
  const route = params.get('at');
  if (!route || !/^\/cases\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\?[A-Za-z0-9_=&%.-]*)?$/i.test(route)) return null;
  return `https://roviq-core-customer.pages.dev${route}`;
}
