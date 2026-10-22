import assert from 'node:assert/strict';
import {test} from 'node:test';
import {FEEDS,fetchFeed,toFeedVehicle} from '../scripts/dealer-feeds.mjs';
const feed=FEEDS[0];
const listing=(changes={})=>({vin:'1FTFW5L88TFC17689',year:2023,make:'Ford',model:'F-150',trim:'XLT',type:'Used',
  mileage:18729,styles:{exterior_color:'Black'},pricing:{our_price:44106},...changes});

test('sparse Ford listings retain crew-cab evidence from a complete Ford VIN',()=>{
  assert.equal(toFeedVehicle(listing(),feed).trim,'XLT SuperCrew');
  assert.equal(toFeedVehicle(listing(),feed).raw.cabEvidence,'ford_vin');
  assert.equal(toFeedVehicle(listing({model:'F-250SD',vin:'1FT8W2BT1TED12345'}),feed).trim,'XLT Crew Cab');
  for(const changes of [{vin:'1FTFX1E81TKD12345'},{vin:'XXXXW'},{styles:{style_name:'XL SuperCab'}},{styles:{style_name:'XL Regular Cab'}},{make:'Chevrolet',model:'Silverado 1500',vin:'3GCUDJE83RG250738'}]){
    assert.equal(toFeedVehicle(listing(changes),feed),null);
  }
});
test('missing or malformed mileage never becomes a zero-mile used truck',()=>{
  for(const mileage of [undefined,null,'','unknown','12k','40001',40001,-1])assert.equal(toFeedVehicle(listing({mileage}),feed),null);
  assert.equal(toFeedVehicle(listing({mileage:0}),feed).mileage,0);
  assert.equal(toFeedVehicle(listing({mileage:40000}),feed).mileage,40000);
});
test('explicit search projection restores GM cab and mechanical evidence when dealer defaults omit it',async()=>{
  let request;
  const fetcher=async(url,init)=>{
    if(url===feed.pageUrl)return new Response('<script>var SEARCH_SERVICE = {"search":"https://search.test/listings","apiKey":"public-test-key"}; var x=1;</script>');
    request=JSON.parse(init.body);
    const full=request.requestedFields.includes('styles.style_name');
    return Response.json({data:{listings:[listing({make:'Chevrolet',model:'Silverado 1500',vin:'3GCUDJE83RG250738',
      styles:full?{style_name:'4WD Crew Cab 157 High Country'}:{exterior_color:'Gray'},
      mechanical:full?{drivetrain:'4WD',engine:'3.0L I6'}:undefined})]}});
  };
  const result=await fetchFeed(feed,fetcher);
  assert.equal(result.vehicles.length,1);assert.equal(result.vehicles[0].drivetrain,'4WD');
  assert.equal(result.vehicles[0].raw.cabEvidence,'listing_description');
  assert.ok(request.requestedFields.includes('mechanical.engine'));
  assert.ok(request.requestedFields.includes('mileage'));
});
