import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { createTransportDispatch } from '../src/services/transport.js';
import { addRepairOrderLine, createRepairOrder } from '../src/services/shop-os-repair-orders.js';
import { deferRepairOrderLine, updateDeferredService } from '../src/services/shop-os-completion.js';

const globalAdmin={role:'admin'} as const;
const ADMIN_KEY=process.env.ADMIN_API_KEY!;
const adminHeaders=()=>({'x-roviq-role':'admin','x-admin-api-key':ADMIN_KEY});

async function maintenanceDomain(){
  return (await pool.query(`select id from domains where code='maintenance' limit 1`)).rows[0].id as string;
}
async function serviceCase(state='provider_selection'){
  const domainId=await maintenanceDomain();
  return (await pool.query(`insert into service_cases(domain_id,case_type,state) values($1,'maintenance',$2) returning id`,[domainId,state])).rows[0].id as string;
}
async function shop(label:string){
  const org=(await pool.query(`insert into organizations(organization_type,display_name) values('shop',$1) returning id`,[`${label}-${Date.now()}-${Math.random()}`])).rows[0].id as string;
  const actor=(await pool.query(`insert into actors(actor_type,status,organization_id) values('shop','active',$1) returning id`,[org])).rows[0].id as string;
  return {org,actor};
}

describe('Devin review round 3 regressions',()=>{
  let app:FastifyInstance;
  beforeAll(async()=>{app=await buildApp();});
  afterAll(async()=>{await app.close();await pool.end();});

  it('keeps an explicit dispatch destination from redirecting an inherited sibling dispatch',async()=>{
    const caseId=await serviceCase('tow_pending');
    const canonical={lat:45.52,lng:-122.68,label:'Canonical shop'};
    await pool.query(`insert into case_spatial_context(case_id,origin,current_vehicle,destination,route_context,source)
      values($1,$2,$2,$3,'{}'::jsonb,'ops')`,[caseId,JSON.stringify({lat:45.50,lng:-122.70}),JSON.stringify(canonical)]);

    const inherited=await createTransportDispatch(globalAdmin,{
      caseId,transportType:'tow',pickupLocation:{lat:45.50,lng:-122.70},dropoffLocation:canonical,
      metadata:{pickupSource:'case_current_vehicle',dropoffSource:'case_spatial'}
    });
    const explicit={lat:45.60,lng:-122.60,label:'Dispatch-only override'};
    const override=await createTransportDispatch(globalAdmin,{
      caseId,transportType:'tow',pickupLocation:{lat:45.50,lng:-122.70},dropoffLocation:explicit,
      metadata:{pickupSource:'case_current_vehicle',dropoffSource:'explicit_dispatch'}
    });

    const spatial=await pool.query(`select destination from case_spatial_context where case_id=$1`,[caseId]);
    expect(spatial.rows[0].destination).toMatchObject(canonical);
    const rows=await pool.query(`select id,dropoff_location,metadata from transport_dispatches where id=any($1::uuid[])`,[[inherited.id,override.id]]);
    const first=rows.rows.find((row)=>row.id===inherited.id);
    const second=rows.rows.find((row)=>row.id===override.id);
    expect(first.dropoff_location).toMatchObject(canonical);
    expect(second.dropoff_location).toMatchObject(explicit);
    expect(second.metadata.dropoffSource).toBe('explicit_dispatch');
  });

  it('rejects booking deferred work onto another case appointment in the same shop',async()=>{
    const s=await shop('Deferred case scope');
    const caseA=await serviceCase('repair_in_progress');
    const caseB=await serviceCase('repair_in_progress');
    await pool.query(`update service_cases set current_owner_role='partner',current_owner_actor_id=$2 where id=any($1::uuid[])`,[[caseA,caseB],s.actor]);

    const order=await createRepairOrder(globalAdmin,{organizationId:s.org,serviceCaseId:caseA});
    const line=await addRepairOrderLine(globalAdmin,order.id,{lineType:'labor',description:'Deferred service',quantity:1,unitPrice:100,unitCost:50});
    await pool.query(`update shop_repair_order_lines set approval_status='deferred' where id=$1`,[line.line.id]);
    const deferred=await deferRepairOrderLine(globalAdmin,{repairOrderId:order.id,repairOrderLineId:line.line.id});

    const appointment=(await pool.query(`insert into roviq_appointments(service_case_id,organization_id,appointment_status,starts_at,ends_at)
      values($1,$2,'held',now()+interval '1 day',now()+interval '1 day 1 hour') returning id`,[caseB,s.org])).rows[0].id as string;

    await expect(updateDeferredService(globalAdmin,deferred.id,{action:'book',appointmentId:appointment}))
      .rejects.toMatchObject({message:'deferred_service_appointment_case_mismatch'});
  });

  it('returns a controlled conflict when an already auto-dispatched demand is routed again',async()=>{
    const domainId=await maintenanceDomain();
    const demand=(await pool.query(`insert into demand_requests(domain_id,demand_type,urgency,attributes,state)
      values($1,'wont_start','urgent','{}'::jsonb,'open') returning id`,[domainId])).rows[0].id as string;
    const provider=(await pool.query(`insert into actors(actor_type,status) values('shop','active') returning id`)).rows[0].id as string;
    const caseId=(await pool.query(`insert into service_cases(domain_id,demand_id,case_type,state,selection_mode,selected_actor_id)
      values($1,$2,'maintenance','provider_pending','auto_dispatch',$3) returning id`,[domainId,demand,provider])).rows[0].id as string;

    const res=await app.inject({method:'POST',url:`/api/admin/demands/${demand}/route`,headers:adminHeaders(),payload:{createOffer:true}});
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({error:'case_already_dispatched',caseId,selectedActorId:provider,retryable:false});
  });
});
