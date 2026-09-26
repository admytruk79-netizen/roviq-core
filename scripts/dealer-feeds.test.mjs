import { describe, expect, it } from 'vitest';
import { FEEDS, fetchFeed, publishToCore, readSearchConfig, toFeedVehicle } from './dealer-feeds.mjs';

const feed = FEEDS[0];
const page = `<script>var SEARCH_SERVICE = {"apiUrl":"https://websites-search.api.carscommerce.inc","ccid":"6067995","apiKey":"public-key","search":"https://websites-search.api.carscommerce.inc/api/v1/listings/6067995","visibleStatusValues":["publish","modified","pend-sale"]}; var SEARCH_SERVICE_FIELD_MAP = {"requestedFields":["vin","pricing"]}; var other = 1;</script>`;
const listing = (o = {}) => ({
  vin: '1FTFW5L88TFC17689', stock: 'GF1', type: 'New', year: 2026, make: 'Ford', model: 'F-150', trim: 'Lariat',
  mileage: 11, vdp_url: 'https://www.kendallfordvancouver.com/inventory/new-2026-ford-f-150-lariat/',
  styles: { style_name: 'LARIAT 4WD SuperCrew Box', exterior_color: 'Blue' },
  mechanical: { drivetrain: '4WD', fuel_type: 'Gasoline Fuel', engine: '3.5L V6 EcoBoost' },
  pricing: { msrp: 79635, our_price: 74835 }, media: { images: ['https://vehicle-images.carscommerce.inc/a.jpg'] }, ...o
});
const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('Kendall Ford of Vancouver feed', () => {
  it('reads the public search settings from the dealer page', () => {
    expect(readSearchConfig(page)).toEqual({
      search: 'https://websites-search.api.carscommerce.inc/api/v1/listings/6067995', apiKey: 'public-key',
      statuses: ['publish', 'modified', 'pend-sale'], requestedFields: ['vin', 'pricing']
    });
    expect(() => readSearchConfig('<html></html>')).toThrow('search_config_not_found');
  });

  it('keeps new crew-cab F-150 and F-250 trucks in every trim, priced at the final dealer price', () => {
    expect(toFeedVehicle(listing(), feed)).toMatchObject({
      id: '1FTFW5L88TFC17689', condition: 'new', model: 'F-150', trim: 'Lariat SuperCrew', priceCents: 7483500,
      dealerName: 'Kendall Ford of Vancouver', drivetrain: '4WD', images: ['https://vehicle-images.carscommerce.inc/a.jpg']
    });
    expect(toFeedVehicle(listing({ model: 'F-250SD', trim: 'XLT', styles: { style_name: 'XLT 4WD Crew Cab 6.75\' Box' } }), feed))
      .toMatchObject({ model: 'F-250 Super Duty', trim: 'XLT Crew Cab' });
    for (const trim of ['XL', 'STX', 'Tremor', 'Raptor', 'King Ranch', 'Platinum'])
      expect(toFeedVehicle(listing({ trim, styles: { style_name: `${trim} 4WD SuperCrew 5.5' Box` } }), feed)).not.toBeNull();
  });

  it('drops other cabs, other models, used trucks and trucks without a price', () => {
    expect(toFeedVehicle(listing({ styles: { style_name: 'XL 4WD SuperCab 6.5\' Box' } }), feed)).toBeNull();
    expect(toFeedVehicle(listing({ styles: { style_name: 'XL 4WD Reg Cab 8\' Box' } }), feed)).toBeNull();
    expect(toFeedVehicle(listing({ model: 'F-350SD', styles: { style_name: 'XL Crew Cab' } }), feed)).toBeNull();
    expect(toFeedVehicle(listing({ model: 'Ranger', styles: { style_name: 'XLT SuperCrew' } }), feed)).toBeNull();
    expect(toFeedVehicle(listing({ type: 'Used' }), feed)).toBeNull();
    expect(toFeedVehicle(listing({ pricing: {} }), feed)).toBeNull();
  });

  it('pages through the search service with the page key and dedupes by VIN', async () => {
    const calls = [];
    const fetcher = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url) === feed.pageUrl) return new Response(page, { status: 200 });
      const n = JSON.parse(init.body).page;
      const rows = n === 1 ? Array.from({ length: 100 }, (_, i) => listing({ vin: `1FTFW5L88TFC${String(10000 + i)}` })) : [listing({ vin: '1FTFW5L88TFC10000' }), listing({ vin: 'X', model: 'Bronco' })];
      return json({ data: { listings: rows } });
    };
    const { scanned, vehicles } = await fetchFeed(feed, fetcher);
    expect(calls[1].url).toBe('https://websites-search.api.carscommerce.inc/api/v1/listings/6067995/search');
    expect(calls[1].init.headers['x-api-key']).toBe('public-key');
    expect(JSON.parse(calls[1].init.body)).toMatchObject({ page: 1, perPage: 100, filters: { type_slug: ['New'] } });
    expect(scanned).toBe(102);
    expect(vehicles).toHaveLength(100);
  });

  it('publishes a complete snapshot to ROVIQ Core as admin with the 8.5% markup', async () => {
    const calls = [];
    const fetcher = async (url, init) => {
      calls.push({ url: String(url), init });
      return String(url).endsWith('/api/auth/login') ? json({ accessToken: 'token' }) : json({ active: 1 });
    };
    await publishToCore(feed, [toFeedVehicle(listing(), feed)], { baseUrl: 'https://core.example', email: 'a@b.c', password: 'pw', fetcher });
    expect(calls[1].url).toBe('https://core.example/api/admin/inventory/sync');
    expect(calls[1].init.headers.authorization).toBe('Bearer token');
    expect(JSON.parse(calls[1].init.body)).toMatchObject({ sourceKey: 'kendall-ford-vancouver-new', markupBps: 850, completeSnapshot: true, payload: { vehicles: [{ condition: 'new' }] } });
  });
});
