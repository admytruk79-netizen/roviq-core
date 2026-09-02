import type { FastifyInstance } from 'fastify';
import { pool } from '../../db/pool.js';
import { loadCaseForPrincipal } from '../../services/case-access.js';

export async function spatialRoutes(app:FastifyInstance){
  app.get('/api/maintenance/cases/:id/spatial',async(req,reply)=>{
    const{id}=req.params as{id:string};
    try{
      const c=await loadCaseForPrincipal(req.principal,id);
      if(!c)return reply.code(404).send({error:'case_not_found'});
      const r=await pool.query(
        `select case_id,origin,current_vehicle,destination,diagnostic_location,transport_location,route_context,source,updated_at
         from case_spatial_context where case_id=$1`,[id]
      );
      return{spatial:r.rows[0]??{case_id:id,origin:null,current_vehicle:null,destination:null,diagnostic_location:null,transport_location:null,route_context:{},source:null,updated_at:null}};
    }catch(e){
      if(e instanceof Error&&e.message==='forbidden')return reply.code(403).send({error:'forbidden'});
      throw e;
    }
  });
}
