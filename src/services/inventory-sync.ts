import { pool } from '../db/pool.js';

export type InventoryFeedVehicle={
  id:string;vin?:string;year?:number;make:string;model:string;trim?:string;mileage?:number;
  exteriorColor?:string;drivetrain?:string;fuelType?:string;bodyStyle?:string;images?:string[];
  priceCents?:number;marginCents?:number;dealerName?:string;dealerUrl?:string;raw?:Record<string,unknown>;
};

export const DEFAULT_MARKUP_BPS=850;

export async function syncInventoryFeed(sourceKey:string,vehicles:InventoryFeedVehicle[],marginCents=0,completeSnapshot=false,markupBps=DEFAULT_MARKUP_BPS){
  if(!vehicles.length) throw new Error('inventory_feed_empty');
  const valid=vehicles.filter(v=>v.id&&v.make&&v.model);
  if(valid.length!==vehicles.length || new Set(valid.map(v=>v.id)).size!==valid.length) throw new Error('inventory_feed_invalid_or_duplicate');
  if(!Number.isInteger(markupBps)||markupBps<0||markupBps>10000) throw new Error('inventory_feed_invalid_markup');
  if(valid.some(v=>[v.priceCents,v.marginCents].some(n=>n!==undefined&&(!Number.isSafeInteger(n)||n<0)))) throw new Error('inventory_feed_invalid_price');
  const client=await pool.connect();
  try{
    await client.query('begin');
    const seen:string[]=[];
    for(const v of valid){
      seen.push(v.id);
      await client.query(`
        insert into vehicle_inventory(source_key,source_vehicle_id,vin,year,make,model,trim,mileage,exterior_color,drivetrain,fuel_type,body_style,image_urls,source_price_cents,margin_cents,source_dealer_name,source_dealer_url,source_payload,markup_bps,last_seen_at)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,now())
        on conflict(source_key,source_vehicle_id) do update set
          vin=excluded.vin,year=excluded.year,make=excluded.make,model=excluded.model,trim=excluded.trim,mileage=excluded.mileage,
          exterior_color=excluded.exterior_color,drivetrain=excluded.drivetrain,fuel_type=excluded.fuel_type,body_style=excluded.body_style,
          image_urls=excluded.image_urls,source_price_cents=excluded.source_price_cents,margin_cents=excluded.margin_cents,
          source_dealer_name=excluded.source_dealer_name,source_dealer_url=excluded.source_dealer_url,source_payload=excluded.source_payload,
          markup_bps=excluded.markup_bps,status='active',last_seen_at=now(),updated_at=now()`,
        [sourceKey,v.id,v.vin??null,v.year??null,v.make,v.model,v.trim??null,v.mileage??null,v.exteriorColor??null,v.drivetrain??null,v.fuelType??null,v.bodyStyle??null,JSON.stringify(v.images??[]),v.priceCents??null,v.marginCents??marginCents,v.dealerName??null,v.dealerUrl??null,JSON.stringify(v.raw??{}),markupBps]);
    }
    // Feed pages and incremental updates must never remove cars absent from this batch.
    if(completeSnapshot){
      await client.query(`update vehicle_inventory set status='removed',updated_at=now() where source_key=$1 and not(source_vehicle_id=any($2::text[])) and status='active'`,[sourceKey,seen]);
    }
    await client.query('commit');
    return {sourceKey,received:vehicles.length,active:seen.length,completeSnapshot};
  }catch(e){await client.query('rollback');throw e}finally{client.release()}
}

// A complete scrape that matched nothing means every car from that dealer is gone.
export async function retireSourceInventory(sourceKey:string){
  const r=await pool.query(`update vehicle_inventory set status='removed',updated_at=now() where source_key=$1 and status='active'`,[sourceKey]);
  return r.rowCount??0;
}
