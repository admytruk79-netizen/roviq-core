import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

const ADMIN_KEY=process.env.ADMIN_API_KEY!;
const adminHeaders={'x-roviq-role':'admin','x-admin-api-key':ADMIN_KEY};

describe('controlled pilot application restart persistence',()=>{
  let app:FastifyInstance|null=null;

  afterAll(async()=>{
    if(app) await app.close().catch(()=>{});
    await pool.end();
  });

  it('retains an active pilot run across application restart',async()=>{
    const organization=await pool.query(
      `insert into organizations(organization_type,display_name,status)
       values('repair_partner',$1,'active') returning id`,
      [`Restart Pilot ${Date.now()}-${Math.random()}`]
    );
    const location=await pool.query(
      `insert into locations(organization_id,name,country_code,region,city)
       values($1,'Restart Pilot Shop','US','OR','Portland') returning id`,
      [organization.rows[0].id]
    );
    const pilot=await pool.query(
      `insert into pilot_runs(
         organization_id,location_id,status,readiness_snapshot,evidence,started_at
       ) values($1,$2,'active',$3,'{}'::jsonb,now()) returning id`,
      [
        organization.rows[0].id,
        location.rows[0].id,
        JSON.stringify({ready:true,source:'application_restart_test'})
      ]
    );
    const pilotId=pilot.rows[0].id as string;

    app=await buildApp();
    const before=await app.inject({
      method:'GET',
      url:'/api/admin/pilot/runs',
      headers:adminHeaders
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().runs.some((run:any)=>run.id===pilotId&&run.status==='active')).toBe(true);
    await app.close();
    app=null;

    app=await buildApp();
    const after=await app.inject({
      method:'GET',
      url:'/api/admin/pilot/runs',
      headers:adminHeaders
    });
    expect(after.statusCode).toBe(200);
    expect(after.json().runs.some((run:any)=>run.id===pilotId&&run.status==='active')).toBe(true);

    const stored=await pool.query(
      `select status,readiness_snapshot from pilot_runs where id=$1`,
      [pilotId]
    );
    expect(stored.rows[0].status).toBe('active');
    expect(stored.rows[0].readiness_snapshot.source).toBe('application_restart_test');

    await pool.query('delete from pilot_runs where id=$1',[pilotId]);
    await pool.query('delete from organizations where id=$1',[organization.rows[0].id]);
  });
});
