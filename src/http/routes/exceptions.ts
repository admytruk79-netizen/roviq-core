import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../middleware/principal.js';
import { assignException, getExceptionQueue, updateExceptionState } from '../../services/exception-engine.js';

const exceptionState=z.enum(['open','acknowledged','remediating','resolved','dismissed']);

export async function exceptionRoutes(app:FastifyInstance){
  app.get('/api/admin/exceptions/v2',{preHandler:requireRole('admin')},async(req)=>{
    const query=z.object({
      state:exceptionState.optional(),
      severity:z.enum(['info','warning','critical']).optional(),
      limit:z.coerce.number().int().positive().max(500).default(200)
    }).parse(req.query??{});
    return {exceptions:await getExceptionQueue(query)};
  });

  app.post('/api/admin/exceptions/:id/state',{preHandler:requireRole('admin')},async(req,reply)=>{
    const {id}=req.params as {id:string};
    const body=z.object({state:exceptionState,resolutionCode:z.string().min(1).optional(),note:z.string().max(2000).optional()}).parse(req.body);
    try{return {exception:await updateExceptionState(req.principal,id,body)};}
    catch(error){
      const message=error instanceof Error?error.message:'exception_update_failed';
      if(message==='exception_not_found')return reply.code(404).send({error:message});
      if(message==='invalid_exception_transition'||message==='resolution_code_required')return reply.code(409).send({error:message});
      if(message==='exception_admin_only'||message==='forbidden')return reply.code(403).send({error:message});
      throw error;
    }
  });

  app.put('/api/admin/exceptions/:id/assignment',{preHandler:requireRole('admin')},async(req,reply)=>{
    const {id}=req.params as {id:string};
    const body=z.object({ownerActorId:z.string().uuid().nullable().optional(),dueAt:z.string().datetime().nullable().optional()}).parse(req.body);
    try{return {exception:await assignException(req.principal,id,body)};}
    catch(error){
      const message=error instanceof Error?error.message:'exception_assignment_failed';
      if(message==='exception_not_found')return reply.code(404).send({error:message});
      if(message==='exception_admin_only'||message==='forbidden')return reply.code(403).send({error:message});
      throw error;
    }
  });
}
