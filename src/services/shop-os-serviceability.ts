import type { Principal } from '../types/principal.js';
import { assertCaseAccess } from './case-access.js';
import { evaluateServiceability, type ServiceabilityConstraint } from './serviceability.js';
import { httpError, type Queryable } from './shop-os-scheduling-rules.js';

export async function assertManageableServiceCase(
  principal:Principal,
  serviceCaseId:string|null|undefined,
  organizationId:string,
  db:Queryable
){
  if(!serviceCaseId)return;
  try{
    await assertCaseAccess(principal,serviceCaseId,db);
  }catch(error){
    if(error instanceof Error&&error.message==='case_not_found') throw httpError('service_case_not_found',404);
    if(error instanceof Error&&error.message==='forbidden') throw httpError('forbidden',403);
    throw error;
  }
  const linked=await db.query(`
    select (
      exists(
        select 1 from service_cases sc
        join actors owner on owner.id=sc.current_owner_actor_id
        where sc.id=$1 and owner.organization_id=$2
      )
      or exists(
        select 1 from service_cases sc
        join actors selected on selected.id=sc.selected_actor_id
        where sc.id=$1 and selected.organization_id=$2
      )
      or exists(
        select 1 from matches_offers mo
        join actors provider on provider.id=mo.actor_id
        where mo.case_id=$1 and mo.outcome='accepted' and provider.organization_id=$2
      )
    ) as linked`,[serviceCaseId,organizationId]);
  if(!linked.rows[0]?.linked) throw httpError('service_case_tenant_mismatch',409);
}

async function assertOperationalServiceCase(serviceCaseId:string|null|undefined,db:Queryable,intent:'hold'|'confirm'){
  if(!serviceCaseId)return;
  const projected=await db.query(`select constraint_type,status,details from case_constraints where service_case_id=$1`,[serviceCaseId]);
  const constraints:ServiceabilityConstraint[]=projected.rows
    .filter((row:any)=>intent==='confirm'||row.constraint_type!=='customer_time')
    .map((row:any)=>({
      type:row.constraint_type,
      status:row.status,
      required:true,
      details:row.details??{}
    }));
  const decision=evaluateServiceability({
    capacity:{capacityState:'available',confidence:'roviq_native',syncState:'current',capacityUnits:1},
    constraints,
    requirementsProjected:true,
    allowManualVerified:false,
    allowStaleHold:false
  });
  const allowed=intent==='confirm'?decision.confirmable:decision.holdable;
  if(!allowed) throw httpError(intent==='confirm'?'service_case_not_confirmable':'service_case_not_bookable',409);
}

export async function assertConfirmableServiceCase(serviceCaseId:string|null|undefined,db:Queryable){
  await assertOperationalServiceCase(serviceCaseId,db,'confirm');
}

export async function assertBookableServiceCase(serviceCaseId:string|null|undefined,db:Queryable){
  await assertOperationalServiceCase(serviceCaseId,db,'hold');
}
