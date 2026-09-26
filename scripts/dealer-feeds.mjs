// Dealer inventory feeds that run from GitHub Actions, where dealer sites that
// block ROVIQ Core's server (Render) are still reachable. Each feed is pushed
// into ROVIQ Core through the admin inventory sync API, so every truck on the
// site is traceable to its dealer, VIN, source price and sync time.

// Dealer Inspire sites (Kendall Ford of Vancouver) load inventory from the Cars
// Commerce search service. The page carries the public, read-only search
// settings every visitor's browser uses; we read those and query the service.
const PAGE_USER_AGENT = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)';

export const FEEDS = [
  {
    sourceKey: 'kendall-ford-vancouver-new',
    dealerName: 'Kendall Ford of Vancouver',
    pageUrl: 'https://www.kendallfordvancouver.com/new-vehicles/f-150/',
    typeSlug: 'New'
  }
];

export function readSearchConfig(html) {
  const match = html.match(/var SEARCH_SERVICE\s*=\s*(\{[\s\S]*?\});\s*(?:var|\/\*)/);
  if (!match) throw new Error('search_config_not_found');
  const cfg = JSON.parse(match[1]);
  if (!cfg.search || !cfg.apiKey) throw new Error('search_config_incomplete');
  const fieldMap = html.match(/var SEARCH_SERVICE_FIELD_MAP\s*=\s*(\{[\s\S]*?\});\s*(?:var|\/\*)/);
  let requestedFields;
  try { requestedFields = fieldMap ? JSON.parse(fieldMap[1]).requestedFields : undefined; } catch { requestedFields = undefined; }
  return { search: cfg.search, apiKey: cfg.apiKey, statuses: cfg.visibleStatusValues || ['publish'], requestedFields };
}

const MODELS = [
  { test: /^F-?150\b/i, label: m => m.replace(/^F-?150/i, 'F-150') },
  { test: /^F-?250/i, label: () => 'F-250 Super Duty' }
];

// New F-150 and F-250 in every trim, crew cab / SuperCrew only.
export function toFeedVehicle(listing, feed) {
  const model = MODELS.find(m => m.test.test(String(listing.model || '')));
  if (!model || String(listing.type || '').toLowerCase() !== 'new') return null;
  const style = listing.styles?.style_name || listing.styles?.style_description || '';
  const descriptor = [style, listing.trim, listing.extra_fields?.title].filter(Boolean).join(' ');
  if (!/super\s*crew|crew\s*cab/i.test(descriptor)) return null;
  const p = listing.pricing || {};
  const price = [p.our_price, p.internet_price, p.price].map(Number).find(n => Number.isFinite(n) && n >= 1000);
  if (!listing.vin || !price) return null;
  return {
    id: listing.vin,
    vin: listing.vin,
    condition: 'new',
    year: listing.year,
    make: listing.make || 'Ford',
    model: model.label(String(listing.model)),
    trim: [listing.trim, /super\s*crew/i.test(descriptor) ? 'SuperCrew' : 'Crew Cab'].filter(Boolean).join(' '),
    mileage: Number(listing.mileage) || 0,
    exteriorColor: listing.styles?.exterior_color || undefined,
    drivetrain: listing.mechanical?.drivetrain || undefined,
    fuelType: listing.mechanical?.fuel_type || undefined,
    bodyStyle: style || undefined,
    images: (listing.media?.images || []).filter(u => typeof u === 'string').slice(0, 24),
    priceCents: Math.round(price * 100),
    dealerName: feed.dealerName,
    dealerUrl: listing.vdp_url || undefined,
    raw: {
      source: 'cars-commerce-search', stock: listing.stock, style, engine: listing.mechanical?.engine,
      msrp: p.msrp, dealerPrice: price, statusLabel: listing.extra_fields?.lightning?.statusLabel
    }
  };
}

export async function fetchFeed(feed, fetcher = fetch) {
  const page = await fetcher(feed.pageUrl, { headers: { 'user-agent': PAGE_USER_AGENT } });
  if (!page.ok) throw new Error(`dealer_page_${page.status}`);
  const cfg = readSearchConfig(await page.text());
  const listings = [];
  for (let n = 1; n <= 20; n++) {
    const res = await fetcher(cfg.search + '/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-api-key': cfg.apiKey },
      body: JSON.stringify({ page: n, perPage: 100, filters: { status: cfg.statuses, type_slug: [feed.typeSlug] }, requestedFields: cfg.requestedFields })
    });
    if (!res.ok) throw new Error(`search_service_${res.status}`);
    const body = await res.json();
    const batch = body?.data?.listings || body?.listings || [];
    listings.push(...batch);
    if (batch.length < 100) break;
  }
  const seen = new Set();
  const vehicles = listings.map(l => toFeedVehicle(l, feed)).filter(v => v && !seen.has(v.id) && seen.add(v.id));
  return { scanned: listings.length, vehicles };
}

export async function publishToCore(feed, vehicles, { baseUrl, email, password, markupBps = 850, fetcher = fetch }) {
  const login = await fetcher(new URL('/api/auth/login', baseUrl), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password })
  });
  if (!login.ok) throw new Error(`core_login_${login.status}`);
  const { accessToken } = await login.json();
  if (!accessToken) throw new Error('core_token_missing');
  const res = await fetcher(new URL('/api/admin/inventory/sync', baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    // A complete snapshot retires trucks Kendall no longer lists.
    body: JSON.stringify({ sourceKey: feed.sourceKey, markupBps, completeSnapshot: true, payload: { vehicles } })
  });
  if (!res.ok) throw new Error(`core_sync_${res.status}:${(await res.text()).slice(0, 200)}`);
  return res.json();
}
