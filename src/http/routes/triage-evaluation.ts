import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { evaluateTriage, recordGroundTruth } from '../../services/triage-evaluation.js';
import { requireRole } from '../middleware/principal.js';

export async function triageEvaluationRoutes(app:FastifyInstance){
  app.post('/api/triage/:id/ground-truth',{preHandler:requireRole('admin','diagnostic','partner')},async(req,reply)=>{
    const {id}=req.params as {id:string};
    const body=z.object({
      confirmedDrivability:z.enum(['unknown','drivable','limited','non_drivable']),
      confirmedCapabilities:z.array(z.string()).default([]),
      confirmedSafetyFlags:z.array(z.string()).default([]),
      confirmedFaultCategory:z.string().optional(),
      notes:z.string().optional()
    }).parse(req.body);
    return reply.code(201).send({groundTruth:await recordGroundTruth(req.principal,{assessmentId:id,...body})});
  });

  app.post('/api/admin/triage/evaluate',{preHandler:requireRole('admin')},async(req)=>{
    const body=z.object({engineVersion:z.string().optional()}).parse(req.body??{});
    return {evaluation:await evaluateTriage(req.principal,body.engineVersion)};
  });

  app.get('/api/admin/triage/evaluations',{preHandler:requireRole('admin')},async()=>{
    const r=await pool.query(`select * from triage_evaluation_runs order by created_at desc limit 200`);
    return {evaluations:r.rows};
  });

  app.put('/api/admin/triage/promotion-policy',{preHandler:requireRole('admin')},async(req)=>{
    const body=z.object({name:z.string().min(1),minimumSampleSize:z.number().int().positive().default(200),minimumSafetyRecall:z.number().min(0).max(1).default(0.995),minimumDrivabilityAccuracy:z.number().min(0).max(1).default(0.95),minimumCapabilityRecall:z.number().min(0).max(1).default(0.95),maximumCriticalMisses:z.number().int().min(0).default(0),active:z.boolean().default(true)}).parse(req.body);
    if(body.active) await pool.query('update triage_promotion_policy set active=false,updated_at=now() where active=true');
    const r=await pool.query(`insert into triage_promotion_policy(name,minimum_sample_size,minimum_safety_recall,minimum_drivability_accuracy,minimum_capability_recall,maximum_critical_misses,active) values($1,$2,$3,$4,$5,$6,$7) on conflict(name) do update set minimum_sample_size=excluded.minimum_sample_size,minimum_safety_recall=excluded.minimum_safety_recall,minimum_drivability_accuracy=excluded.minimum_drivability_accuracy,minimum_capability_recall=excluded.minimum_capability_recall,maximum_critical_misses=excluded.maximum_critical_misses,active=excluded.active,updated_at=now() returning *`,[body.name,body.minimumSampleSize,body.minimumSafetyRecall,body.minimumDrivabilityAccuracy,body.minimumCapabilityRecall,body.maximumCriticalMisses,body.active]);
    return {policy:r.rows[0]};
  });
}
