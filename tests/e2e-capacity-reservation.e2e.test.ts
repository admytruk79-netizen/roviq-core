import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { releaseCaseCapacity, reserveCanonicalCapacity } from '../src/services/capacity-reservation.js';

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
});
