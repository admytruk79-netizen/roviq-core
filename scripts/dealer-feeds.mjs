// Dealer inventory feeds that run from GitHub Actions, where dealer sites that
// block ROVIQ Core's server (Render) are still reachable. Each feed is pushed
// into ROVIQ Core through the admin inventory sync API, so every truck on the
// site is traceable to its dealer, VIN, source price and sync time.

// Dealer Inspire sites (Kendall Ford of Vancouver, Courtesy Ford Portland) load inventory from the Cars
// Commerce search service. The page carries the public, read-only search
// settings every visitor's browser uses; we read those and query the service.
// Dealer-marked used and certified pre-owned trucks, including delivery-mileage stock.
// Require an odometer reading; never infer used condition from mileage alone.
export const USED_MAX_MILES = 40000;
const validUsedMileage = (raw, miles) => raw != null && /\d/.test(String(raw)) && Number.isFinite(miles) && miles >= 0 && miles <= USED_MAX_MILES;
const isUsedType = t => /\b(used|certified|pre-?owned|cpo)\b/i.test(String(t || ''));

const PAGE_USER_AGENT = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)';

export const FEEDS = [
  {
    sourceKey: 'kendall-ford-vancouver-used-trucks',
    dealerName: 'Kendall Ford of Vancouver',
    pageUrl: 'https://www.kendallfordvancouver.com/used-vehicles/',
    // Certified pre-owned trucks are used stock with the same mileage cap.
    typeSlugs: ['Used', 'Certified Used'],
    condition: 'used'
  },
  {
    sourceKey: 'courtesy-ford-portland-used-trucks',
    dealerName: 'Courtesy Ford (Portland)',
    // The search settings are dealership-wide; only the new-vehicles page carries them.
    pageUrl: 'https://www.courtesyford.com/new-vehicles/',
    typeSlugs: ['Used', 'Certified Used'],
    condition: 'used'
  },
  // Carr Buick GMC (Vancouver) lists the same Carr group used stock, so it is read once here.
  {
    sourceKey: 'carr-chevrolet-beaverton-used-trucks',
    dealerName: 'Carr Chevrolet (Beaverton)',
    platform: 'dealer-com',
    pageUrl: 'https://www.carrchevrolet.com/used-inventory/index.htm',
    models: ['Silverado 1500', 'Silverado 2500HD', 'Sierra 1500', 'Sierra 2500HD', 'F-150', 'Super Duty F-250 SRW'],
    condition: 'used'
  },
  {
    sourceKey: 'buick-gmc-beaverton-used-trucks',
    dealerName: 'Buick GMC of Beaverton',
    platform: 'dealeron',
    pageUrl: 'https://www.beavertongmc.com/searchused.aspx',
    condition: 'used'
  },
  {
    sourceKey: 'northside-ford-portland-used-trucks',
    dealerName: 'Northside Ford (Portland)',
    platform: 'jazel',
    pageUrl: 'https://www.northsideford.net/inventory/used-vehicles/',
    modelPaths: ['f-150', 'f-250'],
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
  },
  {
    sourceKey: 'buick-gmc-beaverton-new-trucks',
    dealerName: 'Buick GMC of Beaverton',
    platform: 'dealeron',
    pageUrl: 'https://www.beavertongmc.com/searchnew.aspx',
    condition: 'new'
  },
  {
    sourceKey: 'carr-buick-gmc-vancouver-new-trucks',
    dealerName: 'Carr Buick GMC (Vancouver, WA)',
    platform: 'dealeron',
    pageUrl: 'https://www.carrbuickgmc.com/searchnew.aspx',
    condition: 'new'
  },
  {
    sourceKey: 'northside-ford-portland-new-trucks',
    dealerName: 'Northside Ford (Portland)',
    platform: 'jazel',
    pageUrl: 'https://www.northsideford.net/inventory/new-vehicles/',
    modelPaths: ['f-150', 'f-250'],
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
// Used feeds keep the low-mileage policy (under USED_MAX_MILES); new feeds take
// the dealer's new stock as listed.
export function toFeedVehicle(listing, feed) {
  const condition = feed.condition || 'used';
  const model = MODELS.find(m => m.test.test(String(listing.model || '')));
  const type = String(listing.type || '').toLowerCase();
  // "Certified Used" counts as used; it is flagged so customers see the CPO status.
  if (!model || (condition === 'used' ? !/\bused\b/.test(type) : type !== condition)) return null;
  const certified = condition === 'used' && /certified/.test(type);
  const mileage = Number(listing.mileage) || 0;
  if (mileage < 0 || (condition === 'used' && !validUsedMileage(listing.mileage, mileage))) return null;
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
    trim: [listing.trim, /super\s*crew/i.test(descriptor) ? 'SuperCrew' : 'Crew Cab', certified ? '· Certified Pre-Owned' : ''].filter(Boolean).join(' '),
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
      source: 'cars-commerce-search', certified, stock: listing.stock, style, engine: listing.mechanical?.engine,
      msrp: p.msrp, dealerPrice: price, statusLabel: listing.extra_fields?.lightning?.statusLabel,
      priceFields: { ...priceFields(p), ...Object.fromEntries(Object.entries(p || {}).filter(([k, v]) => v && typeof v === 'object').map(([k, v]) => [k, JSON.stringify(v).slice(0, 300)])) }
    }
  };
}

// Dealer.com sites (Carr Chevrolet) embed each listing page's vehicles as JSON
// objects inside page scripts. We find every object that carries a VIN and
// parse it as data, never the visible page text.
function objectRanges(text) {
  const ranges = [];
  let depth = 0, quote = null, start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || (c === "'" && depth === 0)) quote = c;
    else if (c === '{') { if (depth++ === 0) start = i; }
    else if (c === '}' && depth > 0 && --depth === 0) ranges.push([start, i + 1]);
  }
  return ranges;
}

export function readDealerComVehicles(html) {
  const out = new Map();
  const walk = node => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (typeof node.vin === 'string' && node.vin.length === 17 && node.make && node.model) { if (!out.has(node.vin)) out.set(node.vin, node); return; }
    Object.values(node).forEach(walk);
  };
  const visit = (text, depth) => {
    for (const [a, b] of objectRanges(text)) {
      const chunk = text.slice(a, b);
      if (!chunk.includes('"vin":"')) continue;
      try { walk(JSON.parse(chunk)); }
      catch { if (depth < 6) visit(chunk.slice(1, -1), depth + 1); }
    }
  };
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) if (m[1].includes('"vin":"')) visit(m[1], 0);
  return [...out.values()];
}

// Ford VINs carry the cab in position 5: "W" is SuperCrew / Crew Cab.
const fordCrewVin = (make, vin) => /^ford$/i.test(String(make || '')) && String(vin || '')[4] === 'W';

// Every price-like field a dealer publishes for a listing, kept with the truck so the
// chosen price can be audited against the dealer's page.
export function priceFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (/price|msrp|discount|rebate|saving|incentive|adjust/i.test(k) && (typeof v === 'string' || typeof v === 'number') && String(v).trim()) out[k] = v;
  }
  return out;
}

const money = v => Number(String(v ?? '').replace(/[^0-9.]/g, '')) || 0;

// GM model codes end in 43 for crew cabs (CK10543, CK10743, CK20743, TK10543 ...);
// 53 is Double Cab and 03 Regular Cab.
export function dealerComToFeedVehicle(v, feed) {
  const condition = feed.condition || 'new';
  if (condition === 'used' ? !isUsedType(v.type) : String(v.type || '').toLowerCase() !== condition) return null;
  const model = MODELS.find(m => m.test.test(String(v.model || '')));
  if (!model) return null;
  const crew = /43$/.test(String(v.modelCode || '')) || /crew\s*cab|super\s*crew/i.test([v.trim, v.bodyStyle, ...(v.title || [])].join(' ')) || fordCrewVin(v.make, v.vin);
  if (!crew) return null;
  const attrs = Object.fromEntries((v.trackingAttributes || []).map(a => [a.name, a.value]));
  const mileage = money(attrs.odometer);
  if (condition === 'used' && !validUsedMileage(attrs.odometer, mileage)) return null;
  const dp = v.pricing?.dprice || [];
  // The dealer's own advertised price (e.g. "Carr Price"), not conditional rebates.
  const price = money(dp.find(d => d.type === 'TOTAL')?.value) || money(v.pricing?.retailPrice);
  if (price < 1000) return null;
  const base = new URL(feed.pageUrl).origin;
  return {
    id: v.vin, vin: v.vin, condition, year: Number(v.year) || Number(String(v.title?.[0] || '').slice(0, 4)) || undefined,
    make: v.make, model: model.label(String(v.model)), trim: [v.trim, /F-?150/i.test(v.model) ? 'SuperCrew' : 'Crew Cab'].filter(Boolean).join(' '),
    mileage, exteriorColor: attrs.exteriorColor || undefined, drivetrain: attrs.driveLine || undefined,
    fuelType: attrs.fuelType || v.fuelType || undefined, bodyStyle: 'Crew Cab Pickup',
    images: (v.images || []).map(i => i?.uri).filter(u => typeof u === 'string').slice(0, 24),
    priceCents: Math.round(price * 100), dealerName: feed.dealerName,
    dealerUrl: v.link ? new URL(v.link, base).href : undefined,
    raw: { source: 'dealer-com-widget', stock: v.stockNumber, modelCode: v.modelCode, msrp: money(v.pricing?.retailPrice) || undefined, dealerPrice: price,
      priceFields: { retailPrice: v.pricing?.retailPrice, ...Object.fromEntries(dp.map(d => [`${d.type}:${d.label}${d.isFinalPrice ? '*' : ''}`, d.value])) } }
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

// DealerOn sites (Buick GMC of Beaverton, Carr Buick GMC) render listing cards
// from their own JSON card service; the page's tagging block names the dealer
// and page ids that service needs.
export function readDealerOnIds(html) {
  const m = html.match(/id="dealeron_tagging_data"[^>]*>([^<]+)</);
  if (!m) return null;
  try { const t = JSON.parse(m[1]); return t.dealerId && t.pageId ? { dealerId: String(t.dealerId), pageId: String(t.pageId) } : null; } catch { return null; }
}

// DealerOn cards carry the dealer's full price sheet base64-encoded in
// VehiclePriceLibrary ("MSRP:85895.0;Selling Price:74395.0;...;calc_FINAL PRICE:74645.0").
// VehicleMsrp / TaggingPrice are the sticker price, not what the dealer sells for.
export function readDealerOnPriceLibrary(encoded) {
  if (!encoded) return {};
  let text;
  try { text = Buffer.from(String(encoded), 'base64').toString('utf8'); } catch { return {}; }
  const out = {};
  for (const part of text.split(';')) {
    const i = part.indexOf(':');
    if (i <= 0) continue;
    const n = Number(part.slice(i + 1).replace(/^:+/, ''));
    if (Number.isFinite(n)) out[part.slice(0, i).trim()] = n;
  }
  return out;
}

// The dealer's advertised selling price: final price (after everyone-qualifies
// rebates, before conditional offers, with dealer fees), else the internet price.
export function dealerOnSellingPrice(card) {
  const lib = readDealerOnPriceLibrary(card.VehiclePriceLibrary);
  const fee = lib.dealer_fee || 0;
  return [lib['calc_FINAL PRICE'], lib['calc_INTERNET PRICE'], lib['Selling Price'] && lib['Selling Price'] + fee,
    money(card.VehicleInternetPrice), money(card.TaggingPrice)].find(n => n >= 1000) || 0;
}

export function dealerOnToFeedVehicle(card, feed) {
  const condition = feed.condition || 'new';
  const vin = String(card.VehicleVin || '');
  if (vin.length !== 17) return null;
  const type = card.VehicleType || card.VehicleCondition || condition;
  if (condition === 'used' ? !isUsedType(type) : String(type).toLowerCase() !== condition) return null;
  const model = MODELS.find(m => m.test.test(String(card.VehicleModel || '')));
  if (!model) return null;
  const crew = /43$/.test(String(card.VehicleModelCode || '')) || /crew\s*cab|super\s*crew/i.test(`${card.VehicleBodyStyle || ''} ${card.VehicleTrim || ''}`) || fordCrewVin(card.VehicleMake, vin);
  if (!crew) return null;
  const mileage = money(card.VehicleMileage);
  if (condition === 'used' && !validUsedMileage(card.VehicleMileage, mileage)) return null;
  const price = dealerOnSellingPrice(card);
  if (price < 1000) return null;
  const origin = new URL(feed.pageUrl).origin;
  const photos = card.VehicleImageModel?.VehicleImageCarouselModel?.PhotoList || [];
  return {
    id: vin, vin, condition, year: Number(card.VehicleYear) || undefined, make: card.VehicleMake || 'GMC',
    model: model.label(String(card.VehicleModel)), trim: [card.VehicleTrim, /F-?150/i.test(card.VehicleModel) ? 'SuperCrew' : 'Crew Cab'].filter(Boolean).join(' '),
    mileage, exteriorColor: card.ExteriorColorLabel || undefined, drivetrain: card.VehicleDriveTrain || undefined,
    fuelType: card.VehicleFuelType || undefined, bodyStyle: card.VehicleBodyStyle || 'Crew Cab Pickup',
    images: [...new Set(photos)].filter(u => typeof u === 'string').map(u => new URL(u, origin).href).slice(0, 24),
    priceCents: Math.round(price * 100), dealerName: feed.dealerName, dealerUrl: card.VehicleDetailUrl || undefined,
    raw: { source: 'dealeron-cards', stock: card.VehicleStockNumber, modelCode: card.VehicleModelCode, engine: card.VehicleEngine, msrp: money(card.VehicleMsrp) || undefined, dealerPrice: price, priceFields: { ...priceFields(card), VehiclePriceLibrary: undefined, ...readDealerOnPriceLibrary(card.VehiclePriceLibrary) } }
  };
}

async function fetchDealerOnFeed(feed, fetcher) {
  const origin = new URL(feed.pageUrl).origin;
  const page = await fetcher(feed.pageUrl, { headers: { 'user-agent': PAGE_USER_AGENT } });
  if (!page.ok) throw new Error(`dealer_page_${page.status}`);
  const ids = readDealerOnIds(await page.text());
  if (!ids) throw new Error('dealeron_ids_not_found');
  // Model names differ per store ("Sierra 2500HD" vs "Sierra 2500 HD"): read all
  // new stock when the service allows it, else each spelling, skipping rejects.
  const seen = new Map();
  const readCards = async model => {
    for (let pt = 1; pt <= 15; pt++) {
      const api = `${origin}/api/vhcliaa/vehicle-pages/cosmos/srp/vehicles/${ids.dealerId}/${ids.pageId}?pt=${pt}&pn=96` +
        `${model ? `&model=${encodeURIComponent(model)}` : ''}&host=${new URL(origin).host}`;
      const res = await fetcher(api, { headers: { 'user-agent': PAGE_USER_AGENT, accept: 'application/json' } });
      if (!res.ok) return res.status;
      const body = await res.json();
      for (const c of body?.DisplayCards || []) if (c?.VehicleCard?.VehicleVin) seen.set(c.VehicleCard.VehicleVin, c.VehicleCard);
      if (pt >= (body?.Paging?.PaginationDataModel?.TotalPages || 1)) break;
    }
    return 200;
  };
  if (await readCards(null) !== 200) {
    const statuses = [];
    for (const model of ['Sierra 1500', 'Sierra 2500HD', 'Sierra 2500 HD']) statuses.push(await readCards(model));
    if (!statuses.includes(200)) throw new Error(`dealeron_cards_${statuses.join('/')}`);
  }
  const vehicles = [...seen.values()].map(c => dealerOnToFeedVehicle(c, feed)).filter(Boolean);
  return { scanned: seen.size, vehicles };
}

// Jazel sites (Northside Ford) put each listing's details in a base64 JSON
// data-event-details attribute. Ford VINs carry the cab in position 5:
// "W" is SuperCrew / Crew Cab (1FTFW, 1FTEW, 1FT7W, 1FT8W ...).
export function readJazelVehicles(html) {
  const images = new Map();
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { const o = JSON.parse(m[1]); if (o?.vehicleIdentificationNumber && o.image) images.set(o.vehicleIdentificationNumber, [].concat(o.image)[0]); } catch {}
  }
  const out = new Map();
  for (const m of html.matchAll(/data-event-details='([^']+)'/g)) {
    try {
      const d = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
      if (d?.vin && d.vin.length === 17 && !out.has(d.vin)) out.set(d.vin, { ...d, image: images.get(d.vin) });
    } catch {}
  }
  return [...out.values()];
}

export function jazelToFeedVehicle(d, feed) {
  const condition = feed.condition || 'new';
  if (condition === 'used' ? !isUsedType(d.condition) : String(d.condition || '').toLowerCase() !== condition) return null;
  const model = MODELS.find(m => m.test.test(String(d.model || '')));
  if (!model || d.make !== 'Ford' || d.vin[4] !== 'W') return null;
  const mileage = money(d.mileage);
  if (condition === 'used' && !validUsedMileage(d.mileage, mileage)) return null;
  const price = money(d.price);
  if (price < 1000) return null;
  const f150 = /F-?150/i.test(d.model);
  return {
    id: d.vin, vin: d.vin, condition, year: Number(d.year) || undefined, make: 'Ford', model: model.label(String(d.model)),
    trim: [d.trim, f150 ? 'SuperCrew' : 'Crew Cab'].filter(Boolean).join(' '), mileage,
    exteriorColor: d.exterior_color || undefined, drivetrain: d.drivetrain || undefined, fuelType: d.fuelType || undefined,
    bodyStyle: f150 ? 'SuperCrew' : 'Crew Cab', images: d.image ? [d.image] : [],
    priceCents: Math.round(price * 100), dealerName: feed.dealerName, dealerUrl: undefined,
    raw: { source: 'jazel-listing', stock: d.stockNumber, dealerPrice: price, priceFields: priceFields(d) }
  };
}

async function fetchJazelFeed(feed, fetcher) {
  const seen = new Map();
  for (const path of feed.modelPaths) {
    for (let n = 1; n <= 15; n++) {
      const url = new URL(`${path}/${n > 1 ? `srp-page-${n}/` : ''}`, feed.pageUrl);
      const res = await fetcher(url.href, { headers: { 'user-agent': PAGE_USER_AGENT } });
      if (!res.ok) { if (n > 1) break; throw new Error(`dealer_page_${res.status}`); }
      const fresh = readJazelVehicles(await res.text()).filter(d => !seen.has(d.vin));
      if (!fresh.length) break;
      fresh.forEach(d => seen.set(d.vin, d));
    }
  }
  const vehicles = [...seen.values()].map(d => jazelToFeedVehicle(d, feed)).filter(Boolean);
  return { scanned: seen.size, vehicles };
}

// The search settings are dealership-wide and appear on several pages; if the
// first page comes back without them (bot check, redesign), try the others and
// report what the dealer actually served.
export async function loadSearchConfig(feed, fetcher = fetch) {
  const origin = new URL(feed.pageUrl).origin;
  const pages = [...new Set([feed.pageUrl, `${origin}/`, `${origin}/new-vehicles/`, `${origin}/used-vehicles/`])];
  const seen = [];
  for (const url of pages) {
    const res = await fetcher(url, { headers: { 'user-agent': PAGE_USER_AGENT } });
    const html = res.ok ? await res.text() : '';
    try { if (res.ok) return readSearchConfig(html); } catch {}
    const title = (html.match(/<title[^>]*>([^<]{0,80})/i)?.[1] || '').trim();
    seen.push(`${new URL(url).pathname}=${res.status}${title ? `:${title}` : ''}`);
  }
  throw new Error(`search_config_not_found (${seen.join(', ')})`);
}

export async function fetchFeed(feed, fetcher = fetch) {
  if (feed.platform === 'dealer-com') return fetchDealerComFeed(feed, fetcher);
  if (feed.platform === 'dealeron') return fetchDealerOnFeed(feed, fetcher);
  if (feed.platform === 'jazel') return fetchJazelFeed(feed, fetcher);
  const cfg = await loadSearchConfig(feed, fetcher);
  const listings = [];
  for (let n = 1; n <= 20; n++) {
    const res = await fetcher(cfg.search + '/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-api-key': cfg.apiKey },
      body: JSON.stringify({ page: n, perPage: 100, filters: { status: cfg.statuses, type_slug: feed.typeSlugs ?? [feed.typeSlug] }, requestedFields: cfg.requestedFields })
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
