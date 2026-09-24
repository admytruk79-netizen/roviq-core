import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { assignMobility, createMobilityResource, requestMobility } from '../src/services/mobility.js';

const admin={role:'admin'} as const;

async function newCase(){
  const domain=await pool.query(`select id from domains where code='maintenance' limit 1`);
  const result=await pool.query(
    `insert into service_cases(domain_id,case_type,state)
     values($1,'maintenance','provider_selection') returning id`,
    [domain.rows[0].id]
  );
  return result.rows[0].id as string;
}

describe('mobility assignment contention',()=>{
  afterAll(async()=>{await pool.end();});

  it('prevents one mobility resource from being assigned to two allocations concurrently',async()=>{
    const provider=await pool.query(
      `insert into actors(actor_type,status) values('fleet','active') returning id`
    );
    const resource=await createMobilityResource(admin,{
      actorId:provider.rows[0].id,
      resourceType:'loaner',
      label:'Contention loaner'
    });
    const caseA=await newCase();
    const caseB=await newCase();
    const allocationA=await requestMobility(admin,caseA,{allocationType:'loaner'});
    const allocationB=await requestMobility(admin,caseB,{allocationType:'loaner'});

    const results=await Promise.allSettled([
      assignMobility(admin,allocationA!.id,{providerActorId:provider.rows[0].id,resourceId:resource.id}),
      assignMobility(admin,allocationB!.id,{providerActorId:provider.rows[0].id,resourceId:resource.id})
    ]);

    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    const rejected=results.find(result=>result.status==='rejected');
    expect(rejected?.status).toBe('rejected');
    if(rejected?.status==='rejected') expect(rejected.reason?.message).toBe('resource_unavailable');

    const assigned=await pool.query(
      `select count(*)::int as n
         from mobility_allocations
        where resource_id=$1 and state='assigned'`,
      [resource.id]
    );
    expect(Number(assigned.rows[0].n)).toBe(1);

    const stored=await pool.query(`select status from mobility_resources where id=$1`,[resource.id]);
    expect(stored.rows[0].status).toBe('assigned');
  });
});
