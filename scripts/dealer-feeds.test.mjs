import { describe, expect, it } from 'vitest';
import { FEEDS, dealerComToFeedVehicle, fetchFeed, publishToCore, readDealerComVehicles, readSearchConfig, toFeedVehicle } from './dealer-feeds.mjs';

const feed = FEEDS[0];
const page = `<script>var SEARCH_SERVICE = {"apiUrl":"https://websites-search.api.carscommerce.inc","ccid":"6067995","apiKey":"public-key","search":"https://websites-search.api.carscommerce.inc/api/v1/listings/6067995","visibleStatusValues":["publish","modified","pend-sale"]}; var SEARCH_SERVICE_FIELD_MAP = {"requestedFields":["vin","pricing"]}; var other = 1;</script>`;
const listing = (o = {}) => ({
  vin: '1FTFW5L88TFC17689', stock: 'GF1', type: 'Used', year: 2026, make: 'Ford', model: 'F-150', trim: 'Lariat',
  mileage: 12000, vdp_url: 'https://www.kendallfordvancouver.com/inventory/used-2026-ford-f-150-lariat/',
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

  it('keeps low-mileage used crew-cab F-150 and F-250 trucks, priced at the final dealer price', () => {
    expect(toFeedVehicle(listing(), feed)).toMatchObject({
      id: '1FTFW5L88TFC17689', condition: 'used', model: 'F-150', trim: 'Lariat SuperCrew', priceCents: 7483500,
      dealerName: 'Kendall Ford of Vancouver', drivetrain: '4WD', images: ['https://vehicle-images.carscommerce.inc/a.jpg']
    });
    expect(toFeedVehicle(listing({ model: 'F-250SD', trim: 'XLT', styles: { style_name: 'XLT 4WD Crew Cab 6.75\' Box' } }), feed))
      .toMatchObject({ model: 'F-250 Super Duty', trim: 'XLT Crew Cab' });
    for (const trim of ['XL', 'STX', 'Tremor', 'Raptor', 'King Ranch', 'Platinum'])
      expect(toFeedVehicle(listing({ trim, styles: { style_name: `${trim} 4WD SuperCrew 5.5' Box` } }), feed)).not.toBeNull();
  });

  it('drops other cabs, other models, new or high-mileage trucks and trucks without a price', () => {
    expect(toFeedVehicle(listing({ styles: { style_name: 'XL 4WD SuperCab 6.5\' Box' } }), feed)).toBeNull();
    expect(toFeedVehicle(listing({ styles: { style_name: 'XL 4WD Reg Cab 8\' Box' } }), feed)).toBeNull();
    expect(toFeedVehicle(listing({ model: 'F-350SD', styles: { style_name: 'XL Crew Cab' } }), feed)).toBeNull();
    expect(toFeedVehicle(listing({ model: 'Ranger', styles: { style_name: 'XLT SuperCrew' } }), feed)).toBeNull();
    expect(toFeedVehicle(listing({ type: 'New' }), feed)).toBeNull();
    expect(toFeedVehicle(listing({ mileage: 30000 }), feed)).toBeNull();
    expect(toFeedVehicle(listing({ pricing: {} }), feed)).toBeNull();
  });

  it('new-truck feed keeps new crew-cab trucks at any delivery mileage and rejects used ones', () => {
    const newFeed = FEEDS.find(f => f.condition === 'new');
    expect(newFeed).toMatchObject({ dealerName: 'Kendall Ford of Vancouver', typeSlug: 'New' });
    expect(toFeedVehicle(listing({ type: 'New', mileage: 5 }), newFeed)).toMatchObject({ condition: 'new', mileage: 5, priceCents: 7483500 });
    expect(toFeedVehicle(listing({ type: 'New', mileage: undefined }), newFeed)).toMatchObject({ mileage: 0 });
    expect(toFeedVehicle(listing(), newFeed)).toBeNull();
    expect(toFeedVehicle(listing({ type: 'New', styles: { style_name: 'XL 4WD Reg Cab 8\' Box' } }), newFeed)).toBeNull();
  });

  it('accepts crew-cab Silverado and Sierra 1500/2500 but not 3500', () => {
    const gm = o => listing({ make: 'GMC', model: 'Sierra 1500', trim: 'Denali', styles: { style_name: '4WD Crew Cab 147" Denali' }, ...o });
    expect(toFeedVehicle(gm(), feed)).toMatchObject({ model: 'Sierra 1500', trim: 'Denali Crew Cab' });
    expect(toFeedVehicle(gm({ model: 'Sierra 2500HD' }), feed)).toMatchObject({ model: 'Sierra 2500 HD' });
    expect(toFeedVehicle(gm({ make: 'Chevrolet', model: 'Silverado 1500' }), feed)).toMatchObject({ model: 'Silverado 1500' });
    expect(toFeedVehicle(gm({ model: 'Sierra 3500HD' }), feed)).toBeNull();
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
    expect(JSON.parse(calls[1].init.body)).toMatchObject({ page: 1, perPage: 100, filters: { type_slug: ['Used'] } });
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
    expect(JSON.parse(calls[1].init.body)).toMatchObject({ sourceKey: 'kendall-ford-vancouver-used-trucks', markupBps: 850, completeSnapshot: true, payload: { vehicles: [{ condition: 'used' }] } });
  });
});

describe('Carr Chevrolet (dealer.com) feed', () => {
  const carr = FEEDS.find(f => f.platform === 'dealer-com');
  const vehicle = (o = {}) => ({
    title: ['2026 Chevrolet', 'Silverado 1500 Custom Trail Boss'], make: 'Chevrolet', model: 'Silverado 1500', trim: 'Custom Trail Boss',
    modelCode: 'CK10743', vin: '3GCUKCEDXTG495865', stockNumber: 'C269133', type: 'new', bodyStyle: 'Truck',
    link: '/new/Chevrolet/2026-Chevrolet-Silverado-1500-de05b2f3.htm',
    images: [{ uri: 'https://pictures.dealer.com/a.jpg' }],
    pricing: { retailPrice: '$58,910', dprice: [
      { label: 'MSRP', type: 'MIDDLE', value: '$58,910' }, { label: 'Carr Price', type: 'TOTAL', value: '$53,910' },
      { label: 'Final Price', type: 'SIF', value: '$47,910', isFinalPrice: true }] },
    trackingAttributes: [{ name: 'odometer', value: '4540' }, { name: 'driveLine', value: '4WD' }, { name: 'fuelType', value: 'Gasoline Fuel' }],
    ...o
  });
  const page = list => `<script> DDC = DDC || {}; DDC.WidgetData["inventory-data-bus1"] = {"inventory":${JSON.stringify(list)},"note":"a \\"quoted\\" } brace"}; </script>`;

  it('reads vehicles from the embedded widget JSON', () => {
    expect(readDealerComVehicles(page([vehicle()])).map(v => v.vin)).toEqual(['3GCUKCEDXTG495865']);
    expect(readDealerComVehicles('<html></html>')).toEqual([]);
  });

  it('keeps crew cabs at the dealer advertised price, not conditional rebates', () => {
    expect(dealerComToFeedVehicle(vehicle(), carr)).toMatchObject({
      vin: '3GCUKCEDXTG495865', condition: 'new', year: 2026, model: 'Silverado 1500', trim: 'Custom Trail Boss Crew Cab',
      priceCents: 5391000, mileage: 4540, drivetrain: '4WD', dealerName: 'Carr Chevrolet (Beaverton)',
      dealerUrl: 'https://www.carrchevrolet.com/new/Chevrolet/2026-Chevrolet-Silverado-1500-de05b2f3.htm'
    });
    expect(dealerComToFeedVehicle(vehicle({ model: 'Silverado 2500HD', modelCode: 'CK20743' }), carr)).toMatchObject({ model: 'Silverado 2500 HD' });
  });

  it('drops double and regular cabs, 3500s, used stock and unpriced trucks', () => {
    expect(dealerComToFeedVehicle(vehicle({ modelCode: 'CK10753' }), carr)).toBeNull();
    expect(dealerComToFeedVehicle(vehicle({ modelCode: 'CK10903' }), carr)).toBeNull();
    expect(dealerComToFeedVehicle(vehicle({ model: 'Silverado 3500HD', modelCode: 'CK30743' }), carr)).toBeNull();
    expect(dealerComToFeedVehicle(vehicle({ type: 'used' }), carr)).toBeNull();
    expect(dealerComToFeedVehicle(vehicle({ pricing: {} }), carr)).toBeNull();
  });

  it('pages each model with start= until no new VINs appear', async () => {
    const urls = [];
    const fetcher = async url => {
      urls.push(url);
      const u = new URL(url); const start = Number(u.searchParams.get('start') || 0);
      const list = start === 0 ? [vehicle(), vehicle({ vin: '3GCUKCEDXTG495866' })] : start === 2 ? [vehicle({ vin: '3GCUKCEDXTG495867', modelCode: 'CK10753' })] : [];
      return new Response(page(list));
    };
    const r = await fetchFeed(carr, fetcher);
    expect(r.vehicles.map(v => v.vin)).toEqual(['3GCUKCEDXTG495865', '3GCUKCEDXTG495866']);
    expect(urls[0]).toContain('model=Silverado+1500');
    expect(urls[1]).toContain('start=2');
  });
});
