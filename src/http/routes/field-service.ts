import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { requireRole } from '../middleware/principal.js';
import { loadCaseForPrincipal } from '../../services/case-access.js';
import { audit } from '../../services/audit.js';
import { appendCaseEvent } from '../../services/orchestration.js';
import { setCustomerSnapshot } from '../../services/operations.js';

const safetySchema = z.object({
  fireRisk:z.boolean().default(false),
  fuelLeak:z.boolean().default(false),
  highVoltageRisk:z.boolean().default(false),
  brakeSteeringRisk:z.boolean().default(false),
  unstableVehicle:z.boolean().default(false),
  roadsideUnsafe:z.boolean().default(false)
}).default({});

const assessmentSchema = z.object({
  demandId:z.string().uuid().optional(),
  diagnosticFindingId:z.string().uuid().optional(),
  summary:z.string().min(3),
  repairClass:z.enum(['battery','tire','ignition','electrical_minor','fluid_service','minor_mechanical','unknown']).default('unknown'),
  drivability:z.enum(['drivable','limited','non_drivable','unknown']).default('unknown'),
  confidence:z.number().min(0).max(1).default(0.5),
  safety:safetySchema,
  requiredCapabilities:z.array(z.string().min(1)).default([]),
  requiredTools:z.array(z.string().min(1)).default([]),
  requiredParts:z.array(z.record(z.unknown())).default([]),
  operatorCapabilities:z.array(z.string().min(1)).default([]),
  operatorTools:z.array(z.string().min(1)).default([]),
  operatorCanPerform:z.boolean().default(false),
  partsAvailable:z.boolean().default(false),
  estimatedMinutes:z.number().int().nonnegative().max(720).optional(),
  estimatedCost:z.number().nonnegative().optional(),
  customerAuthorizationRequired:z.boolean().default(true),
  evidence:z.record(z.unknown()).default({}),
  metadata:z.record(z.unknown()).default({})
});

type Assessment = z.infer<typeof assessmentSchema>;

function includesAll(have:string[], need:string[]) { const set=new Set(have); return need.every(v=>set.has(v)); }
function decide(a:Assessment) {
  const unsafe=Object.values(a.safety).some(Boolean);
  if (unsafe || a.drivability === 'non_drivable') return 'tow_required' as const;
  if (a.confidence < 0.75) return 'remote_review' as const;
  if (!a.operatorCanPerform) return 'dispatch_field_technician' as const;
  if (!includesAll(a.operatorCapabilities,a.requiredCapabilities) || !includesAll(a.operatorTools,a.requiredTools)) return 'dispatch_field_technician' as const;
  if (a.requiredParts.length > 0 && !a.partsAvailable) return 'dispatch_field_technician' as const;
  if (a.repairClass === 'unknown') return 'remote_review' as const;
  return 'field_repair' as const;
}

export async function fieldServiceRoutes(app:FastifyInstance) {
  app.get('/api/maintenance/cases/:id/field-service', async (req,reply)=>{
    const {id}=req.params as {id:string};
    try {
      const c=await loadCaseForPrincipal(req.principal,id);
      if(!c) return reply.code(404).send({error:'case_not_found'});
      const r=await pool.query('select * from field_service_decisions where case_id=$1 order by created_at desc',[id]);
      return {decisions:r.rows};
    } catch(e) {
      if(e instanceof Error&&e.message==='forbidden') return reply.code(403).send({error:'forbidden'});
      throw e;
    }
  });

  app.post('/api/maintenance/cases/:id/field-service/assess',{preHandler:requireRole('diagnostic','tow','partner','admin')},async(req,reply)=>{
    const {id}=req.params as {id:string};
    const b=assessmentSchema.parse(req.body);
    const c=await loadCaseForPrincipal(req.principal,id);
    if(!c) return reply.code(404).send({error:'case_not_found'});
    const action=decide(b);
    const authorizationRequired=b.customerAuthorizationRequired && (action==='field_repair'||action==='temporary_stabilization');
    const status=authorizationRequired?'authorization_required':'proposed';
    const r=await pool.query(
      `insert into field_service_decisions(case_id,demand_id,diagnostic_finding_id,created_by_actor_id,action,status,repair_class,drivability,confidence,summary,safety_flags,required_capabilities,required_tools,required_parts,operator_context,evidence,estimated_minutes,estimated_cost,customer_authorization_required,metadata)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) returning *`,
      [id,b.demandId??c.demand_id??null,b.diagnosticFindingId??null,req.principal.actorId??null,action,status,b.repairClass,b.drivability,b.confidence,b.summary,JSON.stringify(b.safety),JSON.stringify(b.requiredCapabilities),JSON.stringify(b.requiredTools),JSON.stringify(b.requiredParts),JSON.stringify({canPerform:b.operatorCanPerform,capabilities:b.operatorCapabilities,tools:b.operatorTools,partsAvailable:b.partsAvailable,role:req.principal.role}),JSON.stringify(b.evidence),b.estimatedMinutes??null,b.estimatedCost??null,b.customerAuthorizationRequired,JSON.stringify(b.metadata)]
    );
    await appendCaseEvent(id,'FIELD_SERVICE_DECISION_PROPOSED',req.principal,{decisionId:r.rows[0].id,action,status});
    await setCustomerSnapshot(id,'field_service_assessment',action==='tow_required'?'On-site assessment requires vehicle transport.':action==='field_repair'?'An on-site repair is available.':'The on-site assessment is being reviewed.',authorizationRequired?'Approval required':'ROVIQ is coordinating the next action');
    await audit(req.principal,'create_field_service_decision','service_case',id,action,{decisionId:r.rows[0].id,status});
    return reply.code(201).send({decision:r.rows[0]});
  });

  app.post('/api/maintenance/cases/:id/field-service/:decisionId/authorize',{preHandler:requireRole('customer','admin')},async(req,reply)=>{
    const {id,decisionId}=req.params as {id:string;decisionId:string};
    const b=z.object({approved:z.boolean()}).parse(req.body);
    const c=await loadCaseForPrincipal(req.principal,id);
    if(!c) return reply.code(404).send({error:'case_not_found'});
    const existing=await pool.query('select * from field_service_decisions where id=$1 and case_id=$2',[decisionId,id]);
    if(!existing.rowCount) return reply.code(404).send({error:'field_service_decision_not_found'});
    const status=b.approved?'authorized':'declined';
    const r=await pool.query(`update field_service_decisions set status=$1,authorized_by_actor_id=$2,customer_authorized_at=case when $3 then now() else customer_authorized_at end,updated_at=now() where id=$4 returning *`,[status,req.principal.actorId??null,b.approved,decisionId]);
    await appendCaseEvent(id,b.approved?'FIELD_SERVICE_AUTHORIZED':'FIELD_SERVICE_DECLINED',req.principal,{decisionId,action:r.rows[0].action});
    await setCustomerSnapshot(id,b.approved?'field_service_authorized':'field_service_declined',b.approved?'On-site work has been authorized.':'On-site work was declined.',b.approved?'Field operator may begin approved work':'ROVIQ will arrange another service path');
    return {decision:r.rows[0]};
  });

  app.post('/api/maintenance/cases/:id/field-service/:decisionId/start',{preHandler:requireRole('diagnostic','tow','partner','admin')},async(req,reply)=>{
    const {id,decisionId}=req.params as {id:string;decisionId:string};
    const d=await pool.query('select * from field_service_decisions where id=$1 and case_id=$2',[decisionId,id]);
    if(!d.rowCount) return reply.code(404).send({error:'field_service_decision_not_found'});
    if(d.rows[0].customer_authorization_required && d.rows[0].status!=='authorized') return reply.code(409).send({error:'field_service_authorization_required'});
    if(!['field_repair','temporary_stabilization'].includes(d.rows[0].action)) return reply.code(409).send({error:'field_service_action_not_executable'});
    const r=await pool.query(`update field_service_decisions set status='in_progress',started_at=now(),updated_at=now() where id=$1 returning *`,[decisionId]);
    await appendCaseEvent(id,'FIELD_SERVICE_STARTED',req.principal,{decisionId,action:r.rows[0].action});
    return {decision:r.rows[0]};
  });

  app.post('/api/maintenance/cases/:id/field-service/:decisionId/complete',{preHandler:requireRole('diagnostic','tow','partner','admin')},async(req,reply)=>{
    const {id,decisionId}=req.params as {id:string;decisionId:string};
    const b=z.object({outcome:z.enum(['fixed','stabilized','failed','escalated']),notes:z.string().optional(),evidence:z.record(z.unknown()).optional()}).parse(req.body);
    const status=b.outcome==='failed'||b.outcome==='escalated'?'escalated':'completed';
    const r=await pool.query(`update field_service_decisions set status=$1,outcome=$2,completed_at=now(),evidence=evidence || $3::jsonb,metadata=metadata || $4::jsonb,updated_at=now() where id=$5 and case_id=$6 returning *`,[status,b.outcome,JSON.stringify(b.evidence??{}),JSON.stringify(b.notes?{completionNotes:b.notes}:{}),decisionId,id]);
    if(!r.rowCount) return reply.code(404).send({error:'field_service_decision_not_found'});
    await appendCaseEvent(id,'FIELD_SERVICE_COMPLETED',req.principal,{decisionId,outcome:b.outcome});
    await setCustomerSnapshot(id,b.outcome==='fixed'?'field_service_fixed':b.outcome==='stabilized'?'field_service_stabilized':'field_service_escalated',b.outcome==='fixed'?'Vehicle repaired on site.':b.outcome==='stabilized'?'Vehicle stabilized on site.':'On-site work could not be completed safely.',b.outcome==='fixed'?'Confirm resolution':b.outcome==='stabilized'?'Continue with approved next step':'ROVIQ will arrange towing or specialist service');
    return {decision:r.rows[0]};
  });
}
