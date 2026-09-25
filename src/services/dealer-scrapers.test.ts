import {describe,expect,it} from 'vitest';
import {extractAlgoliaConfig,isTargetTruck,jsonLdVehicles,mapDealerComVehicle,mapDealerInspireHit,scrapeDealer,type DealerSource} from './dealer-scrapers.js';

const carr:DealerSource={key:'carr',name:'Carr Chevrolet',baseUrl:'https://www.carrchevrolet.com',platform:'dealer.com'};
const damerow:DealerSource={key:'damerow',name:'Damerow Ford',baseUrl:'https://www.damerowford.com',platform:'dealer-inspire'};
const truck=(o:Record<string,unknown>)=>({id:'x',make:'Ford',model:'F-150',trim:'XLT SuperCrew',mileage:30000,raw:{condition:'used'},...o});
const json=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});

describe('target truck filter',()=>{
  it('keeps used crew-cab F-150, F-250, Silverado and Sierra 1500/2500 under 50k miles',()=>{
    expect(isTargetTruck(truck({}))).toBe(true);
    expect(isTargetTruck(truck({model:'Super Duty F-250 SRW',trim:'Lariat 4WD Crew Cab 6.75\' Box'}))).toBe(true);
    expect(isTargetTruck(truck({make:'Chevrolet',model:'Silverado 1500',trim:'LT',bodyStyle:'Crew Cab Pickup'}))).toBe(true);
    expect(isTargetTruck(truck({make:'Chevrolet',model:'Silverado 2500HD',trim:'LTZ Crew Cab'}))).toBe(true);
    expect(isTargetTruck(truck({make:'GMC',model:'Sierra 1500',trim:'AT4 Crew Cab'}))).toBe(true);
  });
  it('rejects high mileage, unknown mileage, other cabs, other models and new trucks',()=>{
    expect(isTargetTruck(truck({mileage:50000}))).toBe(false);
    expect(isTargetTruck(truck({mileage:undefined}))).toBe(false);
    expect(isTargetTruck(truck({trim:'XL SuperCab'}))).toBe(false);
    expect(isTargetTruck(truck({trim:'XL Regular Cab'}))).toBe(false);
    expect(isTargetTruck(truck({make:'Chevrolet',model:'Silverado 1500',trim:'LT Double Cab'}))).toBe(false);
    expect(isTargetTruck(truck({model:'Ranger',trim:'XLT SuperCrew'}))).toBe(false);
    expect(isTargetTruck(truck({make:'Chevrolet',model:'Silverado 3500HD',trim:'LTZ Crew Cab'}))).toBe(false);
    expect(isTargetTruck(truck({mileage:12,raw:{condition:'new'}}))).toBe(false);
    expect(isTargetTruck(truck({mileage:8,raw:{condition:''}}))).toBe(false);
  });
});

describe('Dealer.com scraper',()=>{
  it('maps the inventory API and pages through results',async()=>{
    const item=(n:number)=>({uuid:`u${n}`,vin:`VIN${n}`,year:2022,make:'Chevrolet',model:'Silverado 1500',trim:'LT',bodyStyle:'Crew Cab Pickup',type:'used',
      link:`/used/Chevrolet/2022-Chevrolet-Silverado-1500-${n}.htm`,images:[{uri:'https://pictures.dealer.com/a.jpg'}],
      pricing:{retailPrice:'$50,000',dprice:[{value:'$52,000'},{value:'$48,995',isFinalPrice:true}]},
      trackingAttributes:[{name:'odometer',value:'21,345 miles'},{name:'exteriorColor',value:'Black'}]});
    const urls:string[]=[];
    const fetcher=async(url:string)=>{urls.push(url);const start=Number(new URL(url).searchParams.get('start'));
      return json({pageInfo:{totalCount:101},inventory:start===0?Array.from({length:100},(_,i)=>item(i)):[item(100)]})};
    const vehicles=await scrapeDealer(carr,fetcher);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('/apis/widget/INVENTORY_LISTING_DEFAULT_AUTO_USED:inventory-data-bus1/getInventory?start=0&pageSize=100');
    expect(vehicles).toHaveLength(101);
    expect(vehicles[0]).toMatchObject({id:'u0',vin:'VIN0',mileage:21345,priceCents:4899500,exteriorColor:'Black',
      dealerUrl:'https://www.carrchevrolet.com/used/Chevrolet/2022-Chevrolet-Silverado-1500-0.htm',images:['https://pictures.dealer.com/a.jpg']});
    expect(isTargetTruck(vehicles[0])).toBe(true);
    expect(mapDealerComVehicle({uuid:'p',make:'Ford',model:'F-150',pricing:{retailPrice:'Call for price'}},carr).priceCents).toBeUndefined();
  });
});

describe('Dealer Inspire scraper',()=>{
  it('reads Algolia settings from the listing page and queries the index',async()=>{
    const html=`<script>var inventoryLightningSettings={"appId":"SEWJN80HTN","apiKeySearch":"179608f32563367799314290254e3e44","inventoryIndex":"damerowford_production_inventory"};</script>`;
    expect(extractAlgoliaConfig(html)).toEqual({appId:'SEWJN80HTN',apiKey:'179608f32563367799314290254e3e44',index:'damerowford_production_inventory'});
    const calls:{url:string;init?:RequestInit}[]=[];
    const fetcher=async(url:string,init?:RequestInit)=>{calls.push({url,init});
      if(url.includes('algolia')) return json({nbPages:1,hits:[{objectID:'1FTFW1E5',vin:'1FTFW1E5',type:'Used',year:2021,make:'Ford',model:'F-150',trim:'Lariat',body:'SuperCrew Cab',miles:'34,120',our_price:45990,link:'https://www.damerowford.com/inventory/used-2021-ford-f-150/',thumbnail:'https://img/1.jpg'}]});
      return new Response(html,{status:200})};
    const vehicles=await scrapeDealer(damerow,fetcher);
    expect(calls[1].url).toBe('https://SEWJN80HTN-dsn.algolia.net/1/indexes/damerowford_production_inventory/query');
    expect((calls[1].init?.headers as Record<string,string>)['x-algolia-api-key']).toBe('179608f32563367799314290254e3e44');
    expect(vehicles[0]).toMatchObject({id:'1FTFW1E5',mileage:34120,priceCents:4599000,images:['https://img/1.jpg']});
    expect(isTargetTruck(vehicles[0])).toBe(true);
    expect(mapDealerInspireHit({objectID:'n',type:'New',make:'Ford',model:'F-150',body:'SuperCrew',miles:5,our_price:60000},damerow)).toSatisfy(v=>!isTargetTruck(v as any));
  });

  it('falls back to schema.org JSON-LD when no Algolia settings are on the page',async()=>{
    const html=`<script type="application/ld+json">{"@context":"https://schema.org","@type":"Car","name":"Used 2020 Ford F-250 Lariat Crew Cab","vehicleIdentificationNumber":"1FT7W2BT","brand":{"@type":"Brand","name":"Ford"},"model":"Super Duty F-250 SRW","vehicleModelDate":"2020","itemCondition":"https://schema.org/UsedCondition","mileageFromOdometer":{"@type":"QuantitativeValue","value":41000},"offers":{"price":"55995"},"url":"/inventory/used-2020-ford-f-250/"}</script>`;
    const vehicles=await scrapeDealer(damerow,async()=>new Response(html,{status:200}));
    expect(vehicles).toEqual(jsonLdVehicles(html,damerow));
    expect(vehicles[0]).toMatchObject({id:'1FT7W2BT',make:'Ford',year:2020,mileage:41000,priceCents:5599500,dealerUrl:'https://www.damerowford.com/inventory/used-2020-ford-f-250/'});
    expect(isTargetTruck(vehicles[0])).toBe(true);
  });
});
