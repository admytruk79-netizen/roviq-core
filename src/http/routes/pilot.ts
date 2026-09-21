import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../middleware/principal.js';
import { getPilotReadiness } from '../../services/pilot-readiness.js';
import { addPilotRunCase, createPilotRun, finishPilotRun, getPilotRunCases, getPilotRunHealth, listPilotRuns, startPilotRun } from '../../services/pilot-runs.js';

export async function pilotRoutes(app:FastifyInstance){
  app.get('/api/admin/pilot/runs',{preHandler:requireRole('admin')},async(req)=>{
    return {runs:await listPilotRuns(req.principal)};
  });

  app.post('/api/admin/pilot/runs',{preHandler:requireRole('admin')},async(req,reply)=>{
    const body=z.object({organizationId:z.string().uuid(),locationId:z.string().uuid()}).parse(req.body);
    try{
      return reply.code(201).send({run:await createPilotRun(req.principal,body)});
    }catch(error){
      const statusCode=(error as {statusCode?:number}).statusCode;
      if(statusCode) return reply.code(statusCode).send({error:error instanceof Error?error.message:'pilot_run_error'});
      throw error;
    }
  });

  app.get('/api/admin/pilot/runs/:id/health',{preHandler:requireRole('admin')},async(req,reply)=>{
    const {id}=z.object({id:z.string().uuid()}).parse(req.params);
    try{return await getPilotRunHealth(req.principal,id);}
    catch(error){
      const statusCode=(error as {statusCode?:number}).statusCode;
      if(statusCode) return reply.code(statusCode).send({error:error instanceof Error?error.message:'pilot_run_error'});
      throw error;
    }
  });

  app.get('/api/admin/pilot/runs/:id/cases',{preHandler:requireRole('admin')},async(req,reply)=>{
    const {id}=z.object({id:z.string().uuid()}).parse(req.params);
    try{return {cases:await getPilotRunCases(req.principal,id)};}
    catch(error){
      const statusCode=(error as {statusCode?:number}).statusCode;
      if(statusCode) return reply.code(statusCode).send({error:error instanceof Error?error.message:'pilot_run_error'});
      throw error;
    }
  });

  app.post('/api/admin/pilot/runs/:id/cases',{preHandler:requireRole('admin')},async(req,reply)=>{
    const {id}=z.object({id:z.string().uuid()}).parse(req.params);
    const body=z.object({caseId:z.string().uuid()}).parse(req.body);
    try{return {cases:await addPilotRunCase(req.principal,id,body.caseId)};}
    catch(error){
      const statusCode=(error as {statusCode?:number}).statusCode;
      if(statusCode) return reply.code(statusCode).send({error:error instanceof Error?error.message:'pilot_run_error'});
      throw error;
    }
  });

  app.post('/api/admin/pilot/runs/:id/start',{preHandler:requireRole('admin')},async(req,reply)=>{
    const {id}=z.object({id:z.string().uuid()}).parse(req.params);
    try{
      return {run:await startPilotRun(req.principal,id)};
    }catch(error){
      const statusCode=(error as {statusCode?:number}).statusCode;
      if(statusCode) return reply.code(statusCode).send({error:error instanceof Error?error.message:'pilot_run_error'});
      throw error;
    }
  });

  app.post('/api/admin/pilot/runs/:id/finish',{preHandler:requireRole('admin')},async(req,reply)=>{
    const {id}=z.object({id:z.string().uuid()}).parse(req.params);
    const body=z.object({
      outcome:z.enum(['completed','aborted']),
      abortReason:z.string().min(3).max(1000).optional(),
      evidence:z.record(z.unknown()).optional()
    }).parse(req.body);
    try{
      return {run:await finishPilotRun(req.principal,id,body)};
    }catch(error){
      const statusCode=(error as {statusCode?:number}).statusCode;
      if(statusCode) return reply.code(statusCode).send({error:error instanceof Error?error.message:'pilot_run_error'});
      throw error;
    }
  });

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
