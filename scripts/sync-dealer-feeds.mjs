import { FEEDS, fetchFeed, publishToCore } from './dealer-feeds.mjs';

const baseUrl = process.env.ROVIQ_CORE_API_URL || 'https://roviq-core.onrender.com';
const email = process.env.ROVIQ_CORE_ADMIN_EMAIL;
const password = process.env.ROVIQ_CORE_ADMIN_PASSWORD;
// --dry-run reads every dealer and prints what would be published, without touching Core.
const dryRun = process.argv.includes('--dry-run');
if (!dryRun && (!email || !password)) throw new Error('ROVIQ_CORE_ADMIN_EMAIL and ROVIQ_CORE_ADMIN_PASSWORD are required');

// Ukraine customer inventory is used-only. New-truck feeds remain defined for future use but are not scraped or published here.
// Dealer sites sometimes refuse one request (rate limit or bot challenge page);
// retry a feed twice, 20s and 40s later, before counting it as failed.
async function fetchFeedWithRetry(feed, attempts = 3) {
  for (let i = 1; ; i++) {
    try { return await fetchFeed(feed); }
    catch (error) {
      if (i >= attempts) throw error;
      console.error(JSON.stringify({ feed: feed.sourceKey, retry: i, error: String(error?.message || error) }));
      await new Promise(r => setTimeout(r, 20000 * i));
    }
  }
}

async function publishWithRetry(feed, vehicles, attempts = 3) {
  for (let i = 1; ; i++) {
    try { return await publishToCore(feed, vehicles, { baseUrl, email, password }); }
    catch (error) {
      const message=String(error?.message||error);
      if (i >= attempts || !/core_login_429|core_sync_429/.test(message)) throw error;
      console.error(JSON.stringify({ feed: feed.sourceKey, publishRetry: i, error: message }));
      await new Promise(r => setTimeout(r, 15000 * i));
    }
  }
}

let failures = 0;
// Only used trucks are published; the dry run also previews new-truck feeds for quotes.
for (const feed of FEEDS.filter(feed => dryRun || feed.condition === 'used')) {
  try {
    const { scanned, vehicles } = await fetchFeedWithRetry(feed);
    // Never publish an empty snapshot: that would wipe the dealer's trucks.
    if (!vehicles.length) throw new Error(`no_matching_trucks (scanned ${scanned})`);
    if (dryRun) {
      console.log(`${feed.sourceKey}: scanned ${scanned}, would publish ${vehicles.length}`);
      for (const v of vehicles) console.log(`  ${v.year} ${v.make} ${v.model} ${v.trim} | ${v.mileage} mi | $${v.priceCents / 100} | ${v.vin} | MSRP ${v.raw?.msrp ?? '-'}`);
      // One JSON line per truck (dealer, listing link, specs) for quotes and audits.
      for (const v of vehicles) console.log('ROW ' + JSON.stringify({ feed: feed.sourceKey, condition: v.condition, dealer: v.dealerName, url: v.dealerUrl ?? null, vin: v.vin, year: v.year,
        make: v.make, model: v.model, trim: v.trim, mileage: v.mileage, dealerPrice: v.priceCents / 100, msrp: v.raw?.msrp || null,
        engine: v.raw?.engine ?? null, drivetrain: v.drivetrain ?? null, color: v.exteriorColor ?? null, stock: v.raw?.stock ?? null, image: v.images?.[0] ?? null }));
      continue;
    }
    const result = await publishWithRetry(feed, vehicles);
    console.log(JSON.stringify({ feed: feed.sourceKey, scanned, published: vehicles.length, result }));
  } catch (error) {
    failures++;
    console.error(JSON.stringify({ feed: feed.sourceKey, error: String(error?.message || error) }));
  }
}
if (failures) process.exit(1);
