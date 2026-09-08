import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {discoverLocalPlaces,getLocalHealth,getLocalRoute} from '../../services/local-adapter.js';

const point=z.object({lat:z.number().min(-90).max(90),lng:z.number().min(-180).max(180)});
const localCategory=z.enum(['food','coffee','breweries','nature','culture','markets','scenic','recreation','family','lodging','automotive','charging','services','other']);

export async function localRoutes(app:FastifyInstance){
  app.get('/api/local/health',async()=>({local:await getLocalHealth()}));

  app.get('/api/local/route',async(req)=>{
    const query=z.object({fromLat:z.coerce.number(),fromLng:z.coerce.number(),toLat:z.coerce.number(),toLng:z.coerce.number()}).parse(req.query);
    const from=point.parse({lat:query.fromLat,lng:query.fromLng});
    const to=point.parse({lat:query.toLat,lng:query.toLng});
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
