import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {discoverLocalPlaces,getLocalHealth,getLocalRoute} from '../../services/local-adapter.js';

const point=z.object({lat:z.number().min(-90).max(90),lng:z.number().min(-180).max(180)});
const localCategory=z.enum(['food','coffee','breweries','nature','culture','markets','scenic','recreation','family','lodging','automotive','charging','services','other']);

export async function localRoutes(app:FastifyInstance){
  app.get('/api/local/health',async()=>({local:await getLocalHealth()}));

  app.get('/api/local/route',async(req)=>{
    const query=z.object({
      fromLat:z.coerce.number().optional(),fromLng:z.coerce.number().optional(),
      toLat:z.coerce.number().optional(),toLng:z.coerce.number().optional(),
      from:z.string().optional(),to:z.string().optional()
    }).parse(req.query);
    const parsePair=(value:string|undefined)=>{
      if(!value)return null;
      const [lngRaw,latRaw,...rest]=value.split(',');
      if(rest.length||latRaw===undefined)return null;
      const lat=Number(latRaw),lng=Number(lngRaw);
      return Number.isFinite(lat)&&Number.isFinite(lng)?point.safeParse({lat,lng}).data??null:null;
    };
    const from=query.fromLat!==undefined&&query.fromLng!==undefined
      ?point.parse({lat:query.fromLat,lng:query.fromLng})
      :parsePair(query.from);
    const to=query.toLat!==undefined&&query.toLng!==undefined
      ?point.parse({lat:query.toLat,lng:query.toLng})
      :parsePair(query.to);
    if(!from||!to)throw new z.ZodError([{code:z.ZodIssueCode.custom,path:['route'],message:'Provide fromLat/fromLng/toLat/toLng or from=lng,lat&to=lng,lat'}]);
    return getLocalRoute(from,to);
  });

  app.get('/api/local/places',async(req)=>{
    const query=z.object({
      lat:z.coerce.number().min(-90).max(90).optional(),
      lng:z.coerce.number().min(-180).max(180).optional(),
      radiusKm:z.coerce.number().min(1).max(250).optional(),
      category:localCategory.optional(),
      city:z.string().trim().min(1).max(120).optional(),
      market:z.string().trim().min(1).max(180).optional(),
      countryCode:z.string().trim().length(2).transform(value=>value.toUpperCase()).optional()
    }).superRefine((value,ctx)=>{
      if((value.lat===undefined)!==(value.lng===undefined))ctx.addIssue({code:z.ZodIssueCode.custom,message:'lat and lng must be provided together',path:['lat']});
    }).parse(req.query);
    return discoverLocalPlaces(query);
  });
}
