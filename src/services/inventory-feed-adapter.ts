import type { InventoryFeedVehicle } from './inventory-sync.js';

function text(v:unknown){return typeof v==='string'&&v.trim()?v.trim():undefined}
function num(v:unknown){const n=Number(v);return Number.isFinite(n)?n:undefined}
function arr(v:unknown){return Array.isArray(v)?v.filter((x):x is string=>typeof x==='string'&&x.length>0):[]}

export function normalizeInventoryPayload(payload:unknown):InventoryFeedVehicle[]{
  const root=payload as any;
  const rows=Array.isArray(root)?root:Array.isArray(root?.vehicles)?root.vehicles:Array.isArray(root?.inventory)?root.inventory:Array.isArray(root?.results)?root.results:[];
  return rows.map((r:any)=>{
    const price=num(r.price_cents??r.priceCents)??((num(r.price??r.salePrice??r.internetPrice)??0)*100||undefined);
    return {
      id:String(r.id??r.stockNumber??r.stock_number??r.vin??''),
      vin:text(r.vin),year:num(r.year),make:text(r.make)??'',model:text(r.model)??'',trim:text(r.trim),
      mileage:num(r.mileage??r.odometer),exteriorColor:text(r.exteriorColor??r.exterior_color??r.color),
      drivetrain:text(r.drivetrain),fuelType:text(r.fuelType??r.fuel_type),bodyStyle:text(r.bodyStyle??r.body_style),
      images:arr(r.images??r.imageUrls??r.image_urls),priceCents:price,
      marginCents:num(r.marginCents??r.margin_cents),
      dealerName:text(r.dealerName??r.dealer_name),dealerUrl:text(r.dealerUrl??r.dealer_url),raw:r
    };
  }).filter((v:InventoryFeedVehicle)=>Boolean(v.id&&v.make&&v.model));
}
