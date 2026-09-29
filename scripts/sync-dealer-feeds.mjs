import { FEEDS, fetchFeed, publishToCore } from './dealer-feeds.mjs';

const baseUrl = process.env.ROVIQ_CORE_API_URL || 'https://roviq-core.onrender.com';
const email = process.env.ROVIQ_CORE_ADMIN_EMAIL;
const password = process.env.ROVIQ_CORE_ADMIN_PASSWORD;
// --dry-run reads every dealer and prints what would be published, without touching Core.
const dryRun = process.argv.includes('--dry-run');
if (!dryRun && (!email || !password)) throw new Error('ROVIQ_CORE_ADMIN_EMAIL and ROVIQ_CORE_ADMIN_PASSWORD are required');

let failures = 0;
for (const feed of FEEDS) {
  try {
    const { scanned, vehicles } = await fetchFeed(feed);
    // Never publish an empty snapshot: that would wipe the dealer's trucks.
    if (!vehicles.length) throw new Error(`no_matching_trucks (scanned ${scanned})`);
    if (dryRun) {
      console.log(`${feed.sourceKey}: scanned ${scanned}, would publish ${vehicles.length}`);
      for (const v of vehicles) console.log(`  ${v.year} ${v.make} ${v.model} ${v.trim} | ${v.mileage} mi | $${v.priceCents / 100} | ${v.vin} | MSRP ${v.raw?.msrp ?? '-'}`);
      continue;
    }
    const result = await publishToCore(feed, vehicles, { baseUrl, email, password });
    console.log(JSON.stringify({ feed: feed.sourceKey, scanned, published: vehicles.length, result }));
  } catch (error) {
    failures++;
    console.error(JSON.stringify({ feed: feed.sourceKey, error: String(error?.message || error) }));
  }
}
if (failures) process.exit(1);
