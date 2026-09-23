import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { requireRole } from '../middleware/principal.js';
import { loadCoreCaseForPrincipal } from '../../services/core-case-access.js';
import { addSagaStep, markSagaNeedsReview, startSaga } from '../../services/saga-recovery.js';

const create=z.object({sagaType:z.string().min(2).max(100),context:z.record(z.unknown()).default({}),firstStep:z.string().min(1).max(100).optional(),input:z.record(z.unknown()).default({})});
export async function sagaRoutes(app:FastifyInstance){
  app.get('/api/core/cases/:id/sagas',async(req,reply)=>{
    const {id}=req.params as {id:string};
    try{const c=await loadCoreCaseForPrincipal(req.principal,id);if(!c)return reply.code(404).send({error:'case_not_found'});}
    catch(e){if(e instanceof Error&&e.message==='forbidden')return reply.code(403).send({error:'forbidden'});throw e;}
    const r=await pool.query('select * from core_sagas where case_id=$1 order by created_at desc',[id]);return{sagas:r.rows};
  });
  app.post('/api/core/cases/:id/sagas',{preHandler:requireRole('admin','partner','diagnostic','tow','parts','fleet')},async(req,reply)=>{
    const {id}=req.params as {id:string};const body=create.parse(req.body);
    try{const c=await loadCoreCaseForPrincipal(req.principal,id);if(!c)return reply.code(404).send({error:'case_not_found'});}
    catch(e){if(e instanceof Error&&e.message==='forbidden')return reply.code(403).send({error:'forbidden'});throw e;}
    const client=await pool.connect();try{await client.query('begin');const saga=await startSaga(id,body.sagaType,body.context,client);const step=body.firstStep?await addSagaStep(saga.id,body.firstStep,body.input,client):null;await client.query('commit');return reply.code(201).send({saga,step});}catch(e){await client.query('rollback');throw e;}finally{client.release();}
  });
  app.post('/api/core/sagas/:id/review',{preHandler:requireRole('admin')},async(req,reply)=>{
    const {id}=req.params as {id:string};const body=z.object({reason:z.string().min(1).max(2000)}).parse(req.body);
    const saga=await markSagaNeedsReview(id,body.reason);if(!saga)return reply.code(404).send({error:'saga_not_found'});return{saga};
  });
}
