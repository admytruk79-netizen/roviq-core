import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { createShopOsAppointment } from '../src/services/shop-os-appointment-create.js';

const admin={role:'admin'} as const;

type ConstraintType='customer_time'|'resource'|'capability'|'parts'|'mobility'|'approval'|'transport'|'other';
type ConstraintStatus='required'|'satisfied'|'waived'|'blocked'|'unknown';

async function setupNativeShop(){
  const org=await pool.query(`insert into organizations(organization_type,display_name) values('shop',$1) returning id`,[
    `Shop OS Constraint Gate ${Date.now()}-${Math.random()}`
  ]);
  const connection=await pool.query(`insert into partner_system_connections(
      organization_id,mode,provider_key,display_name,connection_status
    ) values($1,'roviq_native','roviq','Shop OS Native','active') returning id`,[org.rows[0].id]);
  const resource=await pool.query(`insert into service_resources(
      organization_id,resource_type,display_name,active,source_connection_id,operational_state
    ) values($1,'bay','Constraint Bay',true,$2,'available') returning id`,[org.rows[0].id,connection.rows[0].id]);
  await pool.query(`insert into capacity_windows(
      organization_id,source_connection_id,resource_id,service_category,window_start,window_end,
      capacity_state,capacity_units,nominal_capacity_units,confidence,sync_state
    ) values($1,$2,$3,'repair',now()-interval '1 hour',now()+interval '4 hours',
      'available',8,8,'roviq_native','current')`,[
    org.rows[0].id,connection.rows[0].id,resource.rows[0].id
  ]);
  return {orgId:org.rows[0].id as string,resourceId:resource.rows[0].id as string};
}

async function createCase(orgId:string){
  const domain=await pool.query(`select id from domains where code='maintenance' limit 1`);
  const actor=await pool.query(`insert into actors(actor_type,status,organization_id) values('shop','active',$1) returning id`,[orgId]);
  const created=await pool.query(`insert into service_cases(domain_id,case_type,state,selected_actor_id)
    values($1,'maintenance','provider_pending',$2) returning id`,[domain.rows[0].id,actor.rows[0].id]);
  return created.rows[0].id as string;
}

async function addConstraint(caseId:string,type:ConstraintType,status:ConstraintStatus,key:string){
  await pool.query(`insert into case_constraints(
      service_case_id,constraint_type,status,details,source_type,projection_key,source_updated_at
    ) values($1,$2,$3,'{}'::jsonb,'operational_projection',$4,now())`,[caseId,type,status,key]);
}

function slot(offsetMinutes:number){
  return {
    startsAt:new Date(Date.now()+offsetMinutes*60_000).toISOString(),
    endsAt:new Date(Date.now()+(offsetMinutes+45)*60_000).toISOString()
  };
}

describe('Shop OS fail-closed operational constraint gate',()=>{
  afterAll(async()=>{ await pool.end(); });

  it.each([
    ['parts','required'],
    ['parts','blocked'],
    ['mobility','required'],
    ['mobility','blocked'],
    ['transport','required'],
    ['transport','blocked'],
    ['approval','required'],
    ['approval','blocked'],
    ['provider','required'],
    ['capability','required']
  ] as const)('rejects confirmed booking when %s is %s',async(type,status)=>{
    const {orgId,resourceId}=await setupNativeShop();
    const caseId=await createCase(orgId);
    const canonicalType=(type==='provider'?'other':type) as ConstraintType;
    await addConstraint(caseId,canonicalType,status,`${type}-readiness`);
    const {startsAt,endsAt}=slot(20);

    await expect(createShopOsAppointment(admin,{
      serviceCaseId:caseId,resourceId,startsAt,endsAt,serviceCategory:'repair',status:'confirmed'
    })).rejects.toMatchObject({message:'service_case_not_confirmable',statusCode:409});
  });

  it('allows confirmation when applicable constraints are satisfied or waived',async()=>{
    const {orgId,resourceId}=await setupNativeShop();
    const caseId=await createCase(orgId);
    await addConstraint(caseId,'parts','satisfied','parts-readiness');
    await addConstraint(caseId,'mobility','waived','mobility-readiness');
    await addConstraint(caseId,'transport','satisfied','transport-readiness');
    await addConstraint(caseId,'approval','waived','approval-readiness');
    const {startsAt,endsAt}=slot(30);

    const appointment=await createShopOsAppointment(admin,{
      serviceCaseId:caseId,resourceId,startsAt,endsAt,serviceCategory:'repair',status:'confirmed'
    });
    expect(appointment.appointment_status).toBe('confirmed');
  });

  it('does not circularly block an initial hold on customer-time readiness',async()=>{
    const {orgId,resourceId}=await setupNativeShop();
    const caseId=await createCase(orgId);
    await addConstraint(caseId,'customer_time','required','customer-time-readiness');
    const {startsAt,endsAt}=slot(40);

    const appointment=await createShopOsAppointment(admin,{
      serviceCaseId:caseId,resourceId,startsAt,endsAt,serviceCategory:'repair',status:'held'
    });
    expect(appointment.appointment_status).toBe('held');
  });

  it('does not block when a dependency has no applicable projection',async()=>{
    const {orgId,resourceId}=await setupNativeShop();
    const caseId=await createCase(orgId);
    const {startsAt,endsAt}=slot(50);

    const appointment=await createShopOsAppointment(admin,{
      serviceCaseId:caseId,resourceId,startsAt,endsAt,serviceCategory:'repair',status:'confirmed'
    });
    expect(appointment.appointment_status).toBe('confirmed');
  });
});
