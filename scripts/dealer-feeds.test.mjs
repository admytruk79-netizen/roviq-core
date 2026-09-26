import { describe, expect, it } from 'vitest';
import { FEEDS, dealerComToFeedVehicle, dealerOnToFeedVehicle, fetchFeed, jazelToFeedVehicle, publishToCore, readDealerComVehicles, readDealerOnIds, readJazelVehicles, readSearchConfig, toFeedVehicle } from './dealer-feeds.mjs';

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

describe('DealerOn GMC feeds (Beaverton, Carr Vancouver)', () => {
  const gmc = FEEDS.find(f => f.sourceKey === 'buick-gmc-beaverton-new-trucks');
  const card = (o = {}) => ({
    VehicleVin: '3GTUUDED4TG344911', VehicleType: 'New', VehicleYear: '2026', VehicleMake: 'GMC', VehicleModel: 'Sierra 1500',
    VehicleTrim: 'SLT', VehicleModelCode: 'TK10543', VehicleBodyStyle: 'Crew Cab Pickup', VehicleInternetPrice: '$64,980',
    VehicleMsrp: '$68,680', TaggingPrice: '68680', VehicleMileage: '5', VehicleDriveTrain: '4WD',
    VehicleDetailUrl: 'https://www.beavertongmc.com/new-+Portland-2026-GMC-Sierra+1500-SLT-3GTUUDED4TG344911',
    VehicleImageModel: { VehicleImageCarouselModel: { PhotoList: ['/inventoryphotos/18948/3gtuuded4tg344911/ip/1.jpg', '/inventoryphotos/18948/3gtuuded4tg344911/ip/1.jpg'] } },
    ...o
  });

  it('reads the dealer and page ids the card service needs', () => {
    expect(readDealerOnIds('<script id="dealeron_tagging_data" type="application/json">{"dealerId":"27824","pageId":2918791,"items":[]}</script>'))
      .toEqual({ dealerId: '27824', pageId: '2918791' });
    expect(readDealerOnIds('<html></html>')).toBeNull();
  });

  it('keeps crew-cab Sierras at the internet price with absolute photo URLs', () => {
    expect(dealerOnToFeedVehicle(card(), gmc)).toMatchObject({
      vin: '3GTUUDED4TG344911', condition: 'new', year: 2026, make: 'GMC', model: 'Sierra 1500', trim: 'SLT Crew Cab',
      priceCents: 6498000, mileage: 5, dealerName: 'Buick GMC of Beaverton',
      images: ['https://www.beavertongmc.com/inventoryphotos/18948/3gtuuded4tg344911/ip/1.jpg']
    });
    expect(dealerOnToFeedVehicle(card({ VehicleInternetPrice: '' }), gmc)).toMatchObject({ priceCents: 6868000 });
  });

  it('drops double cabs, 3500s, used and unpriced cards', () => {
    expect(dealerOnToFeedVehicle(card({ VehicleModelCode: 'TK10753', VehicleBodyStyle: 'Double Cab Pickup' }), gmc)).toBeNull();
    expect(dealerOnToFeedVehicle(card({ VehicleModel: 'Sierra 3500HD', VehicleModelCode: 'TK30743' }), gmc)).toBeNull();
    expect(dealerOnToFeedVehicle(card({ VehicleType: 'Used' }), gmc)).toBeNull();
    expect(dealerOnToFeedVehicle(card({ VehicleInternetPrice: '', TaggingPrice: '' }), gmc)).toBeNull();
  });

  it('pages the card service per model', async () => {
    const urls = [];
    const fetcher = async url => {
      urls.push(url);
      if (url.includes('searchnew.aspx')) return new Response('<script id="dealeron_tagging_data" type="application/json">{"dealerId":"27824","pageId":2918791}</script>');
      const pt = Number(new URL(url).searchParams.get('pt'));
      return json({ Paging: { PaginationDataModel: { TotalPages: 2 } }, DisplayCards: [{ VehicleCard: card({ VehicleVin: `3GTUUDED4TG34491${pt}` }) }, { IsAdCard: true }] });
    };
    const r = await fetchFeed(gmc, fetcher);
    expect(r.vehicles.map(v => v.vin)).toEqual(['3GTUUDED4TG344911', '3GTUUDED4TG344912']);
    expect(urls.some(u => u.includes('/api/vhcliaa/vehicle-pages/cosmos/srp/vehicles/27824/2918791') && u.includes('pt=2'))).toBe(true);
  });
});

describe('Northside Ford (Jazel) feed', () => {
  const ns = FEEDS.find(f => f.platform === 'jazel');
  const det = (o = {}) => ({ year: '2026', make: 'Ford', model: 'F-150', trim: 'XLT', bodyType: ['Truck'], vin: '1FTFW3L81TKD12345',
    drivetrain: 'Four Wheel Drive', fuelType: 'Gasoline', condition: 'new', mileage: 12, price: '52,340', stockNumber: 'N1', ...o });
  const tag = d => `<div data-event-details='${Buffer.from(JSON.stringify(d)).toString('base64')}' data-vin='${d.vin}'></div>`;
  const ld = (vin, image) => `<script type="application/ld+json">{"@type":"Car","vehicleIdentificationNumber":"${vin}","image":"${image}"}</script>`;

  it('decodes each listing once and attaches its photo', () => {
    const html = tag(det()) + tag(det()) + ld('1FTFW3L81TKD12345', 'https://media.test/1.jpg') + `<div data-event-details='bm90IGpzb24='></div>`;
    expect(readJazelVehicles(html)).toEqual([{ ...det(), image: 'https://media.test/1.jpg' }]);
  });

  it('keeps new SuperCrew / Crew Cab trucks by the Ford VIN cab code', () => {
    expect(jazelToFeedVehicle(det(), ns)).toMatchObject({ model: 'F-150', trim: 'XLT SuperCrew', priceCents: 5234000, mileage: 12, dealerName: 'Northside Ford (Portland)' });
    expect(jazelToFeedVehicle(det({ model: 'F-250SD', vin: '1FT8W2BT1TED12345' }), ns)).toMatchObject({ model: 'F-250 Super Duty', trim: 'XLT Crew Cab' });
    expect(jazelToFeedVehicle(det({ vin: '1FTFX1E81TKD12345' }), ns)).toBeNull(); // SuperCab
    expect(jazelToFeedVehicle(det({ model: 'Maverick', vin: '3FTTW8B31TRA12345' }), ns)).toBeNull();
    expect(jazelToFeedVehicle(det({ condition: 'used' }), ns)).toBeNull();
    expect(jazelToFeedVehicle(det({ price: '' }), ns)).toBeNull();
  });

  it('walks srp-page-N for each model path until no new VINs', async () => {
    const urls = [];
    const fetcher = async url => {
      urls.push(url);
      if (url.endsWith('/f-150/')) return new Response(tag(det()));
      if (url.endsWith('/f-150/srp-page-2/')) return new Response(tag(det({ vin: '1FTFW3L81TKD12346' })));
      return new Response('');
    };
    const r = await fetchFeed(ns, fetcher);
    expect(r.vehicles.map(v => v.vin)).toEqual(['1FTFW3L81TKD12345', '1FTFW3L81TKD12346']);
    expect(urls).toContain('https://www.northsideford.net/inventory/new-vehicles/f-250/');
  });
});
