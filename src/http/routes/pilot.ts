import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../middleware/principal.js';
import { getPilotReadiness } from '../../services/pilot-readiness.js';

export async function pilotRoutes(app:FastifyInstance){
  app.get('/api/admin/pilot/readiness',{preHandler:requireRole('admin')},async(req,reply)=>{
    const query=z.object({
      organizationId:z.string().uuid().optional(),
      locationId:z.string().uuid().optional()
    }).parse(req.query??{});
    try{
      return await getPilotReadiness(req.principal,query);
    }catch(error){
      const statusCode=(error as {statusCode?:number}).statusCode;
      if(statusCode) return reply.code(statusCode).send({error:error instanceof Error?error.message:'pilot_readiness_error'});
      throw error;
    }
  });
}
