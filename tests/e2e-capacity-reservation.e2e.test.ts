import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { releaseCaseCapacity, reserveCanonicalCapacity } from '../src/services/capacity-reservation.js';
import { createShopOsAppointment } from '../src/services/shop-os.js';

const admin={role:'admin'} as const;

async function createResourceBackedWindow(nominalCapacityUnits=1){
  const org=await pool.query(`insert into organizations(organization_type,display_name) values('shop',$1) returning id`,[`Reservation Race ${Date.now()}-${Math.random()}`]);
  const connection=await pool.query(`insert into partner_system_connections(
      organization_id,mode,provider_key,display_name,connection_status
    ) values($1,'roviq_native','roviq','Shop OS Native','active') returning id`,[org.rows[0].id]);
  const resource=await pool.query(`insert into service_resources(
      organization_id,resource_type,display_name,active,source_connection_id
    ) values($1,'bay','Bay 1',true,$2) returning id`,[org.rows[0].id,connection.rows[0].id]);
  const window=await pool.query(`insert into capacity_windows(
      organization_id,source_connection_id,resource_id,service_category,window_start,window_end,
      capacity_state,capacity_units,nominal_capacity_units,confidence,sync_state
    ) values($1,$2,$3,'repair',now()-interval '1 hour',now()+interval '2 hours',
      'available',$4,$4,'roviq_native','current') returning id`,[
    org.rows[0].id,connection.rows[0].id,resource.rows[0].id,nominalCapacityUnits
  ]);
  return {orgId:org.rows[0].id as string,connectionId:connection.rows[0].id as string,resourceId:resource.rows[0].id as string,windowId:window.rows[0].id as string};
}

async function createCase(orgId?:string){
  const domain=await pool.query(`select id from domains where code='maintenance' limit 1`);
  if(!orgId){
    const created=await pool.query(`insert into service_cases(domain_id,case_type,state) values($1,'maintenance','provider_selection') returning id`,[domain.rows[0].id]);
    return created.rows[0].id as string;
  }
  const actor=await pool.query(`insert into actors(actor_type,status,organization_id) values('shop','active',$1) returning id`,[orgId]);
  const created=await pool.query(`insert into service_cases(domain_id,case_type,state,selected_actor_id)
    values($1,'maintenance','provider_pending',$2) returning id`,[domain.rows[0].id,actor.rows[0].id]);
  return created.rows[0].id as string;
}

async function createCaseAndWindow(){
  const domain=await pool.query(`select id from domains where code='maintenance' limit 1`);
  const org=await pool.query(`insert into organizations(organization_type,display_name) values('shop',$1) returning id`,[`Reservation Test ${Date.now()}-${Math.random()}`]);
  const cases=await pool.query(
    `insert into service_cases(domain_id,case_type,state)
     values($1,'maintenance','provider_selection'),($1,'maintenance','provider_selection') returning id`,
    [domain.rows[0].id]
  );
  const window=await pool.query(
    `insert into capacity_windows(organization_id,service_category,window_start,window_end,capacity_state,capacity_units,confidence,sync_state)
     values($1,'repair',now()-interval '1 minute',now()+interval '1 hour','available',1,'roviq_native','current') returning id`,
    [org.rows[0].id]
  );
  return {caseA:cases.rows[0].id as string,caseB:cases.rows[1].id as string,windowId:window.rows[0].id as string};
}

async function reserveInOwnTransaction(caseId:string,windowId:string){
  const client=await pool.connect();
  try{
    await client.query('begin');
    await reserveCanonicalCapacity(caseId,windowId,client,1);
    await client.query('commit');
    return 'reserved';
  }catch(error){
    await client.query('rollback');
    throw error;
  }finally{client.release();}
}

describe('canonical capacity reservations',()=>{
  afterAll(async()=>{ await pool.end(); });

  it('cannot commit two cases against one capacity unit and restores capacity after release',async()=>{
    const {caseA,caseB,windowId}=await createCaseAndWindow();
    const results=await Promise.allSettled([
      reserveInOwnTransaction(caseA,windowId),
      reserveInOwnTransaction(caseB,windowId)
    ]);

    expect(results.filter((r)=>r.status==='fulfilled')).toHaveLength(1);
    expect(results.filter((r)=>r.status==='rejected')).toHaveLength(1);
    const rejected=results.find((r)=>r.status==='rejected');
    expect(rejected && rejected.status==='rejected' ? rejected.reason.message : '').toBe('capacity_no_longer_available');

    const winner=results[0].status==='fulfilled'?caseA:caseB;
    const loser=winner===caseA?caseB:caseA;
    const client=await pool.connect();
    try{
      await client.query('begin');
      await releaseCaseCapacity(winner,client);
      await client.query('commit');
    }finally{client.release();}

    await expect(reserveInOwnTransaction(loser,windowId)).resolves.toBe('reserved');
  });

  it('a canonical capacity hold on a resource-backed window blocks a Shop OS appointment booking from taking the same unit', async () => {
    // reserveCanonicalCapacity (selection-authority's pre-booking hold, used during provider
    // selection) and assertUsableShopOsCapacity (createShopOsAppointment's own check, used when
    // the actual appointment is scheduled) compute availability from different angles over the
    // same capacity_windows row -- the former nets held capacity_reservations against
    // capacity_units, the latter nets real roviq_appointments *and* other cases' held
    // capacity_reservations against nominal_capacity_units. This test confirms they agree in
    // practice on a single-unit resource-backed window: once case A holds the only unit via
    // canonical reservation, case B cannot get a real Shop OS appointment into that same unit.
    const { orgId, resourceId, windowId } = await createResourceBackedWindow(1);
    const caseA = await createCase(orgId);
    const caseB = await createCase(orgId);
    const start = new Date(Date.now() + 10 * 60_000).toISOString();
    const end = new Date(Date.now() + 70 * 60_000).toISOString();

    await reserveInOwnTransaction(caseA, windowId);

    const heldForA = await pool.query(
      `select count(*)::int as n from capacity_reservations where service_case_id=$1 and capacity_window_id=$2 and state='held'`,
      [caseA, windowId]
    );
    expect(heldForA.rows[0].n).toBe(1);

    await expect(createShopOsAppointment(admin, {
      serviceCaseId: caseB, resourceId, startsAt: start, endsAt: end, serviceCategory: 'repair', status: 'confirmed'
    })).rejects.toMatchObject({ message: 'shop_os_capacity_unavailable', statusCode: 409 });

    // Case A's own hold is unaffected and can still be converted once it actually books.
    const appointment = await createShopOsAppointment(admin, {
      serviceCaseId: caseA, resourceId, startsAt: start, endsAt: end, serviceCategory: 'repair', status: 'confirmed'
    });
    expect(appointment.id).toBeTruthy();
    const consumed = await pool.query(
      `select state from capacity_reservations where service_case_id=$1 and capacity_window_id=$2`,
      [caseA, windowId]
    );
    expect(consumed.rows[0].state).toBe('consumed');
  });
});
