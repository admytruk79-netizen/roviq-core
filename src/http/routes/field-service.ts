import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { requireRole } from '../middleware/principal.js';
import { loadCaseForPrincipal } from '../../services/case-access.js';
import { audit } from '../../services/audit.js';
import { appendCaseEvent } from '../../services/orchestration.js';
import { setCustomerSnapshot } from '../../services/operations.js';
import { createPartsOrder } from '../../services/parts.js';

const executableRepairClass = z.enum(['battery','tire','ignition','electrical_minor','fluid_service','minor_mechanical']);
const repairClass = z.enum(['battery','tire','ignition','electrical_minor','fluid_service','minor_mechanical','unknown']);
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
  operatorActorId:z.string().uuid().optional(),
  summary:z.string().min(3),
  repairClass:repairClass.default('unknown'),
  drivability:z.enum(['drivable','limited','non_drivable','unknown']).default('unknown'),
  confidence:z.number().min(0).max(1).default(0.5),
  safety:safetySchema,
  requiredCapabilities:z.array(z.string().min(1)).default([]),
  requiredTools:z.array(z.string().min(1)).default([]),
  requiredParts:z.array(z.object({
    sku:z.string().min(1),
    quantity:z.number().int().positive(),
    partNumber:z.string().optional(),
    description:z.string().optional()
  })).default([]),
  estimatedMinutes:z.number().int().nonnegative().max(720).optional(),
  estimatedCost:z.number().nonnegative().optional(),
  customerAuthorizationRequired:z.boolean().default(true),
  evidence:z.record(z.unknown()).default({}),
  metadata:z.record(z.unknown()).default({})
});

type Assessment = z.infer<typeof assessmentSchema>;
type CapabilityProfile={actor_id:string;active:boolean;repair_classes:unknown;capabilities:unknown;tools:unknown;max_estimated_minutes:number|null;max_estimated_cost:string|number|null;verified_at:string|null};
type FieldServiceAction='field_repair'|'temporary_stabilization'|'dispatch_field_technician'|'route_to_shop'|'tow_required'|'remote_review';

function stringArray(value:unknown):string[]{return Array.isArray(value)?value.filter((v):v is string=>typeof v==='string'):[]}
function includesAll(have:string[],need:string[]){const set=new Set(have);return need.every(v=>set.has(v))}
function operatorEligible(a:Assessment,p:CapabilityProfile|null){
  if(!p||!p.active||!p.verified_at)return false;
  if(!stringArray(p.repair_classes).includes(a.repairClass))return false;
  if(!includesAll(stringArray(p.capabilities),a.requiredCapabilities))return false;
  if(!includesAll(stringArray(p.tools),a.requiredTools))return false;
  if(a.estimatedMinutes!=null&&p.max_estimated_minutes!=null&&a.estimatedMinutes>p.max_estimated_minutes)return false;
  if(a.estimatedCost!=null&&p.max_estimated_cost!=null&&a.estimatedCost>Number(p.max_estimated_cost))return false;
  return true;
}
function decide(a:Assessment,p:CapabilityProfile|null,partsFulfillable:boolean):FieldServiceAction{
  const unsafe=Object.values(a.safety).some(Boolean);
  if(unsafe||a.drivability==='non_drivable')return'tow_required' as const;
  if(a.confidence<0.75)return'remote_review' as const;
  if(a.repairClass==='unknown')return'remote_review' as const;
  if(!operatorEligible(a,p))return'dispatch_field_technician' as const;
  if(a.requiredParts.length>0&&!partsFulfillable)return'dispatch_field_technician' as const;
  return'field_repair' as const;
}
// Parts fulfilment is authoritative for availability, not the on-scene operator (see
// docs/FIELD_SERVICE_ONSITE_REPAIR_ARCHITECTURE.md's "Parts integration"). Finds one active
// supplier whose inventory can cover every required sku/quantity simultaneously -- not just each
// item individually against possibly-different suppliers, since a single job needs one fulfilling
// source. Returns null (nothing to reserve, or no supplier holds the complete set) accordingly.
async function findFulfillingSupplier(items:{sku:string;quantity:number}[]):Promise<string|null>{
  if(!items.length)return null;
  const first=await pool.query(
    `select distinct supplier_actor_id from parts_inventory where active=true and sku=$1 and (quantity_on_hand-quantity_reserved)>=$2`,
    [items[0].sku,items[0].quantity]
  );
  let candidates=first.rows.map((r:any)=>r.supplier_actor_id as string);
  for(const item of items.slice(1)){
    if(!candidates.length)break;
    const r=await pool.query(
      `select distinct supplier_actor_id from parts_inventory where active=true and sku=$1 and (quantity_on_hand-quantity_reserved)>=$2 and supplier_actor_id=any($3::uuid[])`,
      [item.sku,item.quantity,candidates]
    );
    candidates=r.rows.map((x:any)=>x.supplier_actor_id as string);
  }
  return candidates[0]??null;
}

export async function fieldServiceRoutes(app:FastifyInstance){
  app.get('/api/field-service/me/capabilities',{preHandler:requireRole('diagnostic','tow','partner')},async(req)=>{
    const r=await pool.query('select * from field_service_actor_capabilities where actor_id=$1',[req.principal.actorId]);
    return{capability:r.rows[0]??null};
  });

  app.put('/api/admin/field-service/actors/:actorId/capabilities',{preHandler:requireRole('admin')},async(req,reply)=>{
    const {actorId}=req.params as{actorId:string};
    const b=z.object({
      active:z.boolean().default(true),
      repairClasses:z.array(executableRepairClass).default([]),
      capabilities:z.array(z.string().min(1)).default([]),
      tools:z.array(z.string().min(1)).default([]),
      maxEstimatedMinutes:z.number().int().positive().max(720).nullable().optional(),
      maxEstimatedCost:z.number().nonnegative().nullable().optional(),
      metadata:z.record(z.unknown()).default({})
    }).parse(req.body);
    const actor=await pool.query("select id from actors where id=$1 and status='active'",[actorId]);
    if(!actor.rowCount)return reply.code(404).send({error:'actor_not_found'});
    const r=await pool.query(
      `insert into field_service_actor_capabilities(actor_id,active,repair_classes,capabilities,tools,max_estimated_minutes,max_estimated_cost,verified_by_actor_id,verified_at,metadata,updated_at)
       values($1,$2,$3,$4,$5,$6,$7,$8,now(),$9,now())
       on conflict(actor_id) do update set active=excluded.active,repair_classes=excluded.repair_classes,capabilities=excluded.capabilities,tools=excluded.tools,max_estimated_minutes=excluded.max_estimated_minutes,max_estimated_cost=excluded.max_estimated_cost,verified_by_actor_id=excluded.verified_by_actor_id,verified_at=now(),metadata=excluded.metadata,updated_at=now() returning *`,
      [actorId,b.active,JSON.stringify(b.repairClasses),JSON.stringify(b.capabilities),JSON.stringify(b.tools),b.maxEstimatedMinutes??null,b.maxEstimatedCost??null,req.principal.actorId??null,JSON.stringify(b.metadata)]
    );
    await audit(req.principal,'verify_field_service_capability','actor',actorId,'field_service_capability_profile',{repairClasses:b.repairClasses,active:b.active});
    return{capability:r.rows[0]};
  });

  app.get('/api/maintenance/cases/:id/field-service',async(req,reply)=>{
    const{id}=req.params as{id:string};
    try{
      const c=await loadCaseForPrincipal(req.principal,id);
      if(!c)return reply.code(404).send({error:'case_not_found'});
      const r=await pool.query('select * from field_service_decisions where case_id=$1 order by created_at desc',[id]);
      return{decisions:r.rows};
    }catch(e){if(e instanceof Error&&e.message==='forbidden')return reply.code(403).send({error:'forbidden'});throw e}
  });

  app.post('/api/maintenance/cases/:id/field-service/assess',{preHandler:requireRole('diagnostic','tow','partner','admin')},async(req,reply)=>{
    const{id}=req.params as{id:string};
    const b=assessmentSchema.parse(req.body);
    let c;
    try{c=await loadCaseForPrincipal(req.principal,id);}
    catch(e){if(e instanceof Error&&e.message==='forbidden')return reply.code(403).send({error:'forbidden'});throw e;}
    if(!c)return reply.code(404).send({error:'case_not_found'});
    const operatorActorId=b.operatorActorId??req.principal.actorId??null;
    if(req.principal.role!=='admin'&&operatorActorId!==req.principal.actorId)return reply.code(403).send({error:'operator_override_forbidden'});
    const profileResult=operatorActorId?await pool.query('select * from field_service_actor_capabilities where actor_id=$1',[operatorActorId]):{rows:[]};
    const profile=(profileResult.rows[0]??null) as CapabilityProfile|null;
    const fulfillingSupplierActorId=b.requiredParts.length?await findFulfillingSupplier(b.requiredParts):null;
    const partsFulfillable=b.requiredParts.length===0||fulfillingSupplierActorId!==null;
    const action=decide(b,profile,partsFulfillable);
    const authorizationRequired=b.customerAuthorizationRequired&&(action==='field_repair'||action==='temporary_stabilization');
    const status=authorizationRequired?'authorization_required':'proposed';
    // fulfillingSupplierActorId is the source /start will reserve against -- required_parts is
    // authority data (what the job needs), this is Core's own resolution of who can supply it,
    // so it belongs in metadata rather than mixed into the client-supplied required_parts payload.
    const metadata={...b.metadata,...(fulfillingSupplierActorId?{fulfillingSupplierActorId}:{})};
    const r=await pool.query(
      `insert into field_service_decisions(case_id,demand_id,diagnostic_finding_id,created_by_actor_id,action,status,repair_class,drivability,confidence,summary,safety_flags,required_capabilities,required_tools,required_parts,operator_context,evidence,estimated_minutes,estimated_cost,customer_authorization_required,metadata)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) returning *`,
      [id,b.demandId??c.demand_id??null,b.diagnosticFindingId??null,req.principal.actorId??null,action,status,b.repairClass,b.drivability,b.confidence,b.summary,JSON.stringify(b.safety),JSON.stringify(b.requiredCapabilities),JSON.stringify(b.requiredTools),JSON.stringify(b.requiredParts),JSON.stringify({operatorActorId,verifiedProfile:Boolean(profile?.verified_at),repairClasses:stringArray(profile?.repair_classes),capabilities:stringArray(profile?.capabilities),tools:stringArray(profile?.tools),role:req.principal.role}),JSON.stringify(b.evidence),b.estimatedMinutes??null,b.estimatedCost??null,b.customerAuthorizationRequired,JSON.stringify(metadata)]
    );
    // Core already resolved fulfillability against real inventory above (partsFulfillable) --
    // when it can't be met, open a real trackable order through the same Parts fulfilment path
    // ordinary repairs use, rather than just a text label on the decision.
    let partsOrder=null;
    if(b.requiredParts.length>0&&!partsFulfillable){
      try{
        partsOrder=await createPartsOrder(req.principal,{caseId:id,items:b.requiredParts,attributes:{source:'field_service_required_parts',fieldServiceDecisionId:r.rows[0].id,repairClass:b.repairClass}});
      }catch(error){
        console.warn('field_service_parts_order_failed',{caseId:id,decisionId:r.rows[0].id,error:error instanceof Error?error.message:'unknown_error'});
      }
    }
    await appendCaseEvent(id,'FIELD_SERVICE_DECISION_PROPOSED',req.principal,{decisionId:r.rows[0].id,action,status,operatorActorId,partsOrderId:(partsOrder as any)?.order?.id??null});
    await setCustomerSnapshot(id,'field_service_assessment',action==='tow_required'?'On-site assessment requires vehicle transport.':action==='field_repair'?'An on-site repair is available.':b.requiredParts.length>0&&!partsFulfillable?'Required parts are being sourced for the on-site repair.':'The on-site assessment is being reviewed.',authorizationRequired?'Approval required':b.requiredParts.length>0&&!partsFulfillable?'Waiting for parts availability':'ROVIQ is coordinating the next action');
    await audit(req.principal,'create_field_service_decision','service_case',id,action,{decisionId:r.rows[0].id,status,operatorActorId,partsOrderId:(partsOrder as any)?.order?.id??null});
    return reply.code(201).send({decision:r.rows[0],partsOrder});
  });

  app.post('/api/maintenance/cases/:id/field-service/:decisionId/authorize',{preHandler:requireRole('customer','admin')},async(req,reply)=>{
    const{id,decisionId}=req.params as{id:string;decisionId:string};const b=z.object({approved:z.boolean()}).parse(req.body);
    let c;
    try{c=await loadCaseForPrincipal(req.principal,id);}
    catch(e){if(e instanceof Error&&e.message==='forbidden')return reply.code(403).send({error:'forbidden'});throw e;}
    if(!c)return reply.code(404).send({error:'case_not_found'});
    const existing=await pool.query('select * from field_service_decisions where id=$1 and case_id=$2',[decisionId,id]);if(!existing.rowCount)return reply.code(404).send({error:'field_service_decision_not_found'});
    if(existing.rows[0].status!=='authorization_required')return reply.code(409).send({error:'field_service_not_awaiting_authorization'});
    const status=b.approved?'authorized':'declined';
    const r=await pool.query(`update field_service_decisions set status=$1,authorized_by_actor_id=$2,customer_authorized_at=case when $3 then now() else customer_authorized_at end,updated_at=now() where id=$4 and status='authorization_required' returning *`,[status,req.principal.actorId??null,b.approved,decisionId]);
    if(!r.rowCount)return reply.code(409).send({error:'field_service_not_awaiting_authorization'});
    const sideEffects=await Promise.allSettled([
      appendCaseEvent(id,b.approved?'FIELD_SERVICE_AUTHORIZED':'FIELD_SERVICE_DECLINED',req.principal,{decisionId,action:r.rows[0].action}),
      setCustomerSnapshot(id,b.approved?'field_service_authorized':'field_service_declined',b.approved?'On-site work has been authorized.':'On-site work was declined.',b.approved?'Field operator may begin approved work':'ROVIQ will arrange another service path')
    ]);
    const failed=sideEffects.filter(s=>s.status==='rejected');
    if(failed.length>0)console.warn('field_service_authorize_side_effect_failed',{decisionId,caseId:id,approved:b.approved,failedCount:failed.length});
    return{decision:r.rows[0]};
  });

  app.post('/api/maintenance/cases/:id/field-service/:decisionId/start',{preHandler:requireRole('diagnostic','tow','partner','admin')},async(req,reply)=>{
    const{id,decisionId}=req.params as{id:string;decisionId:string};
    let c;
    try{c=await loadCaseForPrincipal(req.principal,id);}
    catch(e){if(e instanceof Error&&e.message==='forbidden')return reply.code(403).send({error:'forbidden'});throw e;}
    if(!c)return reply.code(404).send({error:'case_not_found'});

    const client=await pool.connect();
    let committed=false;
    let decisionRow:any;
    try{
      await client.query('begin');
      // Row lock for the whole read-check-write sequence: without it, two concurrent start calls
      // on the same decision could both pass the state guard and double-reserve inventory before
      // either commits.
      const d=await client.query('select * from field_service_decisions where id=$1 and case_id=$2 for update',[decisionId,id]);
      if(!d.rowCount)throw new Error('field_service_decision_not_found');
      const decision=d.rows[0];
      // Source state must match exactly: when authorization is waived, only a fresh 'proposed'
      // decision may start; otherwise a completed/escalated/in-progress decision (status != 'proposed'
      // or 'authorized') would restart and clobber its own terminal outcome.
      const startableStatus=decision.customer_authorization_required?'authorized':'proposed';
      if(decision.status!==startableStatus)throw new Error('field_service_not_startable');
      if(!['field_repair','temporary_stabilization'].includes(decision.action))throw new Error('field_service_action_not_executable');
      const operatorActorId=decision.operator_context?.operatorActorId??req.principal.actorId;
      if(req.principal.role!=='admin'&&operatorActorId!==req.principal.actorId)throw new Error('field_service_operator_mismatch');
      const profile=await client.query('select active,verified_at from field_service_actor_capabilities where actor_id=$1',[operatorActorId]);
      if(!profile.rows[0]?.active||!profile.rows[0]?.verified_at)throw new Error('field_service_operator_not_verified');

      // Parts fulfilment is authoritative here, not the operator: reserve against the supplier
      // assess-time resolved as able to cover the complete required set. If that supplier's stock
      // has since changed and can no longer cover it, reject rather than let unsupported work
      // start (docs/FIELD_SERVICE_ONSITE_REPAIR_ARCHITECTURE.md "Parts integration"). decide()
      // only ever reaches field_repair/temporary_stabilization with non-empty required_parts when
      // a fulfilling supplier was found at assess time, so its absence here means stale/tampered state.
      const requiredParts=(decision.required_parts??[]) as {sku:string;quantity:number}[];
      const reservation:{sku:string;quantity:number;inventoryId:string}[]=[];
      if(requiredParts.length){
        const supplierActorId=decision.metadata?.fulfillingSupplierActorId as string|undefined;
        if(!supplierActorId)throw new Error('field_service_parts_unavailable');
        for(const item of requiredParts){
          const inv=await client.query(
            `select * from parts_inventory where supplier_actor_id=$1 and sku=$2 and active=true
             and (quantity_on_hand-quantity_reserved)>=$3 for update`,
            [supplierActorId,item.sku,item.quantity]
          );
          if(!inv.rowCount)throw new Error('field_service_parts_unavailable');
          await client.query('update parts_inventory set quantity_reserved=quantity_reserved+$1,updated_at=now() where id=$2',[item.quantity,inv.rows[0].id]);
          reservation.push({sku:item.sku,quantity:item.quantity,inventoryId:inv.rows[0].id});
        }
      }

      const r=await client.query(
        `update field_service_decisions set status='in_progress',started_at=now(),updated_at=now(),metadata=metadata||$1::jsonb
         where id=$2 and status=$3 returning *`,
        [JSON.stringify(reservation.length?{partsReservation:reservation}:{}),decisionId,startableStatus]
      );
      if(!r.rowCount)throw new Error('field_service_not_startable');
      decisionRow=r.rows[0];
      await client.query('commit');
      committed=true;
    }catch(e){
      if(!committed)await client.query('rollback');
      const message=e instanceof Error?e.message:'field_service_start_failed';
      if(message==='field_service_decision_not_found')return reply.code(404).send({error:message});
      if(message==='field_service_operator_mismatch')return reply.code(403).send({error:message});
      if(['field_service_not_startable','field_service_action_not_executable','field_service_operator_not_verified','field_service_parts_unavailable'].includes(message))return reply.code(409).send({error:message});
      throw e;
    }finally{
      client.release();
    }
    // Best-effort, same reasoning as authorize: the transition already committed, so a failure here
    // must not 500 -- a retry would otherwise be rejected forever by the exact-state guard above.
    await appendCaseEvent(id,'FIELD_SERVICE_STARTED',req.principal,{decisionId,action:decisionRow.action,operatorActorId:decisionRow.operator_context?.operatorActorId}).catch(e=>console.warn('field_service_start_side_effect_failed',{decisionId,caseId:id,error:e instanceof Error?e.message:e}));
    return{decision:decisionRow};
  });

  app.post('/api/maintenance/cases/:id/field-service/:decisionId/complete',{preHandler:requireRole('diagnostic','tow','partner','admin')},async(req,reply)=>{
    const{id,decisionId}=req.params as{id:string;decisionId:string};
    const b=z.object({outcome:z.enum(['fixed','stabilized','failed','escalated']),notes:z.string().optional(),evidence:z.record(z.unknown()).optional()}).parse(req.body);
    let c;
    try{c=await loadCaseForPrincipal(req.principal,id);}
    catch(e){if(e instanceof Error&&e.message==='forbidden')return reply.code(403).send({error:'forbidden'});throw e;}
    if(!c)return reply.code(404).send({error:'case_not_found'});

    const client=await pool.connect();
    let committed=false;
    let decisionRow:any;
    try{
      await client.query('begin');
      const d=await client.query('select * from field_service_decisions where id=$1 and case_id=$2 for update',[decisionId,id]);
      if(!d.rowCount)throw new Error('field_service_decision_not_found');
      const decision=d.rows[0];
      const operatorActorId=decision.operator_context?.operatorActorId??null;
      if(req.principal.role!=='admin'&&operatorActorId!==req.principal.actorId)throw new Error('field_service_operator_mismatch');
      if(decision.status!=='in_progress')throw new Error('field_service_not_in_progress');
      const status=b.outcome==='failed'||b.outcome==='escalated'?'escalated':'completed';
      // Release start's reservation: 'completed' means the parts were actually used (decrement
      // on-hand stock along with the reservation); any other outcome means the job didn't consume
      // them, so only the reservation itself is released back to available stock.
      const reservation=(decision.metadata?.partsReservation??[]) as {sku:string;quantity:number;inventoryId:string}[];
      for(const item of reservation){
        if(status==='completed'){
          await client.query('update parts_inventory set quantity_on_hand=greatest(quantity_on_hand-$1,0),quantity_reserved=greatest(quantity_reserved-$1,0),updated_at=now() where id=$2',[item.quantity,item.inventoryId]);
        }else{
          await client.query('update parts_inventory set quantity_reserved=greatest(quantity_reserved-$1,0),updated_at=now() where id=$2',[item.quantity,item.inventoryId]);
        }
      }
      const r=await client.query(
        `update field_service_decisions set status=$1,outcome=$2,completed_at=now(),evidence=evidence || $3::jsonb,metadata=metadata || $4::jsonb,updated_at=now()
         where id=$5 and case_id=$6 and status='in_progress' returning *`,
        [status,b.outcome,JSON.stringify(b.evidence??{}),JSON.stringify(b.notes?{completionNotes:b.notes}:{}),decisionId,id]
      );
      if(!r.rowCount)throw new Error('field_service_not_in_progress');
      decisionRow=r.rows[0];
      await client.query('commit');
      committed=true;
    }catch(e){
      if(!committed)await client.query('rollback');
      const message=e instanceof Error?e.message:'field_service_complete_failed';
      if(message==='field_service_decision_not_found')return reply.code(404).send({error:message});
      if(message==='field_service_operator_mismatch')return reply.code(403).send({error:message});
      if(message==='field_service_not_in_progress')return reply.code(409).send({error:message});
      throw e;
    }finally{
      client.release();
    }
    // Best-effort, same reasoning as authorize/start: the transition already committed, so a
    // failure here must not 500 -- a retry would otherwise be rejected forever by the 'in_progress' guard above.
    const sideEffects=await Promise.allSettled([
      appendCaseEvent(id,'FIELD_SERVICE_COMPLETED',req.principal,{decisionId,outcome:b.outcome}),
      setCustomerSnapshot(id,b.outcome==='fixed'?'field_service_fixed':b.outcome==='stabilized'?'field_service_stabilized':'field_service_escalated',b.outcome==='fixed'?'Vehicle repaired on site.':b.outcome==='stabilized'?'Vehicle stabilized on site.':'On-site work could not be completed safely.',b.outcome==='fixed'?'Confirm resolution':b.outcome==='stabilized'?'Continue with approved next step':'ROVIQ will arrange towing or specialist service')
    ]);
    const failed=sideEffects.filter(s=>s.status==='rejected');
    if(failed.length>0)console.warn('field_service_complete_side_effect_failed',{decisionId,caseId:id,outcome:b.outcome,failedCount:failed.length});
    return{decision:decisionRow};
  });
}
