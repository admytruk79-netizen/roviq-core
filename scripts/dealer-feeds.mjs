// Dealer inventory feeds that run from GitHub Actions, where dealer sites that
// block ROVIQ Core's server (Render) are still reachable. Each feed is pushed
// into ROVIQ Core through the admin inventory sync API, so every truck on the
// site is traceable to its dealer, VIN, source price and sync time.

// Dealer Inspire sites (Kendall Ford of Vancouver, Courtesy Ford Portland) load inventory from the Cars
// Commerce search service. The page carries the public, read-only search
// settings every visitor's browser uses; we read those and query the service.
const PAGE_USER_AGENT = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)';

export const FEEDS = [
  {
    sourceKey: 'kendall-ford-vancouver-used-trucks',
    dealerName: 'Kendall Ford of Vancouver',
    pageUrl: 'https://www.kendallfordvancouver.com/used-vehicles/',
    typeSlug: 'Used',
    condition: 'used'
  },
  {
    sourceKey: 'kendall-ford-vancouver-new-trucks',
    dealerName: 'Kendall Ford of Vancouver',
    pageUrl: 'https://www.kendallfordvancouver.com/new-vehicles/',
    typeSlug: 'New',
    condition: 'new'
  },
  {
    sourceKey: 'courtesy-ford-portland-new-trucks',
    dealerName: 'Courtesy Ford (Portland)',
    pageUrl: 'https://www.courtesyford.com/new-vehicles/',
    typeSlug: 'New',
    condition: 'new'
  },
  {
    sourceKey: 'carr-chevrolet-beaverton-new-trucks',
    dealerName: 'Carr Chevrolet (Beaverton)',
    platform: 'dealer-com',
    pageUrl: 'https://www.carrchevrolet.com/new-inventory/index.htm',
    models: ['Silverado 1500', 'Silverado 2500HD'],
    condition: 'new'
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
  { test: /^F-?250/i, label: () => 'F-250 Super Duty' },
  { test: /^Silverado\s*(1500|2500)/i, label: m => m.replace(/\s*HD$/i, ' HD').replace(/^Silverado\s*/i, 'Silverado ') },
  { test: /^Sierra\s*(1500|2500)/i, label: m => m.replace(/\s*HD$/i, ' HD').replace(/^Sierra\s*/i, 'Sierra ') }
];

// Crew cab / SuperCrew F-150, F-250, Silverado and Sierra 1500/2500 only.
// Used feeds keep the low-mileage policy (under 30,000 miles); new feeds take
// the dealer's new stock as listed.
export function toFeedVehicle(listing, feed) {
  const condition = feed.condition || 'used';
  const model = MODELS.find(m => m.test.test(String(listing.model || '')));
  if (!model || String(listing.type || '').toLowerCase() !== condition) return null;
  const mileage = Number(listing.mileage) || 0;
  if (mileage < 0 || (condition === 'used' && (!(Number(listing.mileage) > 0) || mileage >= 30000))) return null;
  const style = listing.styles?.style_name || listing.styles?.style_description || '';
  const descriptor = [style, listing.trim, listing.extra_fields?.title].filter(Boolean).join(' ');
  if (!/super\s*crew|crew\s*cab/i.test(descriptor)) return null;
  const p = listing.pricing || {};
  const price = [p.our_price, p.internet_price, p.price].map(Number).find(n => Number.isFinite(n) && n >= 1000);
  if (!listing.vin || !price) return null;
  return {
    id: listing.vin,
    vin: listing.vin,
    condition,
    year: listing.year,
    make: listing.make || 'Ford',
    model: model.label(String(listing.model)),
    trim: [listing.trim, /super\s*crew/i.test(descriptor) ? 'SuperCrew' : 'Crew Cab'].filter(Boolean).join(' '),
    mileage,
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

// Dealer.com sites (Carr Chevrolet) embed each listing page's vehicles as JSON
// in DDC.WidgetData; we read that object literally, never the page text.
export function readDealerComVehicles(html) {
  const at = html.indexOf('DDC.WidgetData["inventory-data-bus1"]');
  if (at < 0) return [];
  const start = html.indexOf('{', at);
  let depth = 0, inString = false, end = -1;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inString) { if (c === '\\') i++; else if (c === '"') inString = false; continue; }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) { end = i; break; }
  }
  if (end < 0) return [];
  let data;
  try { data = JSON.parse(html.slice(start, end + 1)); } catch { return []; }
  const out = [];
  const walk = node => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (typeof node.vin === 'string' && node.vin.length === 17 && node.make) { out.push(node); return; }
    Object.values(node).forEach(walk);
  };
  walk(data);
  return out;
}

const money = v => Number(String(v ?? '').replace(/[^0-9.]/g, '')) || 0;

// GM model codes end in 43 for crew cabs (CK10543, CK10743, CK20743, TK10543 ...);
// 53 is Double Cab and 03 Regular Cab.
export function dealerComToFeedVehicle(v, feed) {
  const condition = feed.condition || 'new';
  if (String(v.type || '').toLowerCase() !== condition) return null;
  const model = MODELS.find(m => m.test.test(String(v.model || '')));
  if (!model) return null;
  const crew = /43$/.test(String(v.modelCode || '')) || /crew\s*cab/i.test([v.trim, ...(v.title || [])].join(' '));
  if (!crew) return null;
  const attrs = Object.fromEntries((v.trackingAttributes || []).map(a => [a.name, a.value]));
  const mileage = money(attrs.odometer);
  if (condition === 'used' && (!mileage || mileage >= 30000)) return null;
  const dp = v.pricing?.dprice || [];
  // The dealer's own advertised price (e.g. "Carr Price"), not conditional rebates.
  const price = money(dp.find(d => d.type === 'TOTAL')?.value) || money(v.pricing?.retailPrice);
  if (price < 1000) return null;
  const base = new URL(feed.pageUrl).origin;
  return {
    id: v.vin, vin: v.vin, condition, year: Number(v.year) || Number(String(v.title?.[0] || '').slice(0, 4)) || undefined,
    make: v.make, model: model.label(String(v.model)), trim: [v.trim, 'Crew Cab'].filter(Boolean).join(' '),
    mileage, exteriorColor: attrs.exteriorColor || undefined, drivetrain: attrs.driveLine || undefined,
    fuelType: attrs.fuelType || v.fuelType || undefined, bodyStyle: 'Crew Cab Pickup',
    images: (v.images || []).map(i => i?.uri).filter(u => typeof u === 'string').slice(0, 24),
    priceCents: Math.round(price * 100), dealerName: feed.dealerName,
    dealerUrl: v.link ? new URL(v.link, base).href : undefined,
    raw: { source: 'dealer-com-widget', stock: v.stockNumber, modelCode: v.modelCode, msrp: money(v.pricing?.retailPrice) || undefined, dealerPrice: price }
  };
}

async function fetchDealerComFeed(feed, fetcher) {
  const seen = new Map();
  let scanned = 0;
  for (const model of feed.models) {
    for (let start = 0, pages = 0; pages < 20; pages++) {
      const url = new URL(feed.pageUrl);
      url.searchParams.set('model', model);
      if (start) url.searchParams.set('start', String(start));
      const res = await fetcher(url.href, { headers: { 'user-agent': PAGE_USER_AGENT } });
      if (!res.ok) throw new Error(`dealer_page_${res.status}`);
      const batch = readDealerComVehicles(await res.text());
      const fresh = batch.filter(v => !seen.has(v.vin));
      scanned += fresh.length;
      fresh.forEach(v => seen.set(v.vin, v));
      if (!fresh.length) break;
      start += batch.length;
    }
  }
  const vehicles = [...seen.values()].map(v => dealerComToFeedVehicle(v, feed)).filter(Boolean);
  return { scanned, vehicles };
}

export async function fetchFeed(feed, fetcher = fetch) {
  if (feed.platform === 'dealer-com') return fetchDealerComFeed(feed, fetcher);
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
