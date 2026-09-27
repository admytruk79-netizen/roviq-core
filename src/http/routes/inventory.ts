import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { requireRole } from '../middleware/principal.js';
import { normalizeInventoryPayload } from '../../services/inventory-feed-adapter.js';
import { syncInventoryFeed } from '../../services/inventory-sync.js';
import { lastInventoryScrape, runInventoryScrapeLocked } from '../../services/inventory-scrape.js';

const querySchema=z.object({
  q:z.string().trim().max(120).optional(),
  make:z.string().trim().max(80).optional(),
  model:z.string().trim().max(80).optional(),
  minYear:z.coerce.number().int().min(1980).max(2100).optional(),
  maxYear:z.coerce.number().int().min(1980).max(2100).optional(),
  condition:z.enum(['new','used']).optional(),
  maxMileage:z.coerce.number().int().min(0).max(1_000_000).optional(),
  maxPriceCents:z.coerce.number().int().min(0).optional(),
  sort:z.enum(['recommended','price_asc','price_desc','miles_asc','year_desc']).default('recommended'),
  limit:z.coerce.number().int().min(1).max(100).default(48),
  offset:z.coerce.number().int().min(0).default(0)
});
const publicFilters=`status='active' and last_seen_at >= now() - interval '24 hours'
  and ($1::text is null or concat_ws(' ',year::text,make,model,trim) ilike '%'||$1||'%')
  and ($2::text is null or make ilike $2)
  and ($3::text is null or model ilike $3)
  and ($4::int is null or year >= $4)
  and ($5::int is null or year <= $5)
  and ($6::int is null or mileage <= $6)
  and ($7::bigint is null or public_price_cents <= $7)
  and ($8::text is null or condition = $8)`;
// Sort keys map to fixed SQL so user input never reaches the ORDER BY clause.
const publicSorts={
  recommended:'year desc,mileage asc nulls last,make,model',
  price_asc:'public_price_cents asc nulls last,year desc',
  price_desc:'public_price_cents desc nulls last,year desc',
  miles_asc:'mileage asc nulls last,year desc',
  year_desc:'year desc nulls last,mileage asc nulls last'
} as const;

export async function inventoryRoutes(app:FastifyInstance){
  app.get('/api/inventory',{config:{public:true}},async(req)=>{
    const q=querySchema.parse(req.query??{});
    const filters=[q.q??null,q.make??null,q.model??null,q.minYear??null,q.maxYear??null,q.maxMileage??null,q.maxPriceCents??null,q.condition??null];
    const r=await pool.query(`
      select id,condition,vin,year,make,model,trim,mileage,exterior_color,drivetrain,fuel_type,body_style,
             image_urls,public_price_cents::int as public_price_cents,public_price_cents::int as price_cents,last_seen_at
      from vehicle_inventory
      where ${publicFilters}
      order by ${publicSorts[q.sort]},id
      limit $9 offset $10`,
      [...filters,q.limit,q.offset]);
    const count=await pool.query(`select count(*)::int as count from vehicle_inventory where ${publicFilters}`,filters);
    return {inventory:r.rows,total:count.rows[0].count,updatedAt:new Date().toISOString(),pricingNotice:'Prices update live from dealer inventory. Taxes, title, registration and dealer fees are extra.'};
  });

  app.get('/api/admin/inventory',{preHandler:requireRole('admin')},async(req)=>{
    const q=querySchema.parse(req.query??{});
    const r=await pool.query(`
      select * from vehicle_inventory
      where ($1::text is null or concat_ws(' ',year::text,make,model,trim,vin) ilike '%'||$1||'%')
      order by updated_at desc limit $2 offset $3`,[q.q??null,q.limit,q.offset]);
    return {inventory:r.rows};
  });

  app.post('/api/admin/inventory/upsert',{preHandler:requireRole('admin')},async(req,reply)=>{
    const b=z.object({
      sourceKey:z.string().min(1),sourceVehicleId:z.string().min(1),vin:z.string().optional(),
      year:z.number().int().optional(),make:z.string().min(1),model:z.string().min(1),trim:z.string().optional(),
      mileage:z.number().int().nonnegative().optional(),exteriorColor:z.string().optional(),drivetrain:z.string().optional(),
      fuelType:z.string().optional(),bodyStyle:z.string().optional(),imageUrls:z.array(z.string().url()).default([]),
      sourcePriceCents:z.number().int().nonnegative().optional(),marginCents:z.number().int().nonnegative().default(0),
      sourceDealerName:z.string().optional(),sourceDealerUrl:z.string().url().optional(),sourcePayload:z.record(z.unknown()).default({})
    }).parse(req.body);
    const r=await pool.query(`
      insert into vehicle_inventory(source_key,source_vehicle_id,vin,year,make,model,trim,mileage,exterior_color,drivetrain,fuel_type,body_style,image_urls,source_price_cents,margin_cents,source_dealer_name,source_dealer_url,source_payload,last_seen_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,now())
      on conflict(source_key,source_vehicle_id) do update set
        vin=excluded.vin,year=excluded.year,make=excluded.make,model=excluded.model,trim=excluded.trim,mileage=excluded.mileage,
        exterior_color=excluded.exterior_color,drivetrain=excluded.drivetrain,fuel_type=excluded.fuel_type,body_style=excluded.body_style,
        image_urls=excluded.image_urls,source_price_cents=excluded.source_price_cents,margin_cents=excluded.margin_cents,
        source_dealer_name=excluded.source_dealer_name,source_dealer_url=excluded.source_dealer_url,source_payload=excluded.source_payload,
        status='active',last_seen_at=now(),updated_at=now()
      returning *`,[b.sourceKey,b.sourceVehicleId,b.vin??null,b.year??null,b.make,b.model,b.trim??null,b.mileage??null,b.exteriorColor??null,b.drivetrain??null,b.fuelType??null,b.bodyStyle??null,JSON.stringify(b.imageUrls),b.sourcePriceCents??null,b.marginCents,b.sourceDealerName??null,b.sourceDealerUrl??null,JSON.stringify(b.sourcePayload)]);
    return reply.code(201).send({vehicle:r.rows[0]});
  });
  app.post('/api/admin/inventory/sync',{preHandler:requireRole('admin')},async(req,reply)=>{
    const body=z.object({sourceKey:z.string().min(1),marginCents:z.number().int().nonnegative().default(0),markupBps:z.number().int().min(0).max(10000).optional(),completeSnapshot:z.boolean().default(false),payload:z.unknown()}).parse(req.body);
    const vehicles=normalizeInventoryPayload(body.payload);
    if(!vehicles.length) return reply.code(400).send({error:'inventory_feed_empty_or_unrecognized'});
    const result=await syncInventoryFeed(body.sourceKey,vehicles,body.marginCents,body.completeSnapshot,body.markupBps);
    return reply.code(202).send(result);
  });

  app.post('/api/admin/inventory/scrape',{preHandler:requireRole('admin')},async(_req,reply)=>{
    const run=await runInventoryScrapeLocked();
    if(!run) return reply.code(409).send({error:'inventory_scrape_in_progress'});
    return reply.code(200).send(run);
  });
  app.get('/api/admin/inventory/scrape',{preHandler:requireRole('admin')},async()=>({lastRun:lastInventoryScrape()??null}));
}
