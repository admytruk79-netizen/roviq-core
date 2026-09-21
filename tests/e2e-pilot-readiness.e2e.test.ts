import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { getPilotReadiness } from '../src/services/pilot-readiness.js';
import { createPilotRun, finishPilotRun, startPilotRun } from '../src/services/pilot-runs.js';

const admin={role:'admin'} as const;

describe('controlled Shop OS pilot readiness gate',()=>{
  let orgId:string;
  let locationId:string;
  let connectionId:string;
  let previousSms:any;
  const previousEnv={
    TWILIO_ACCOUNT_SID:process.env.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN:process.env.TWILIO_AUTH_TOKEN,
    TWILIO_FROM_NUMBER:process.env.TWILIO_FROM_NUMBER,
    STRIPE_SECRET_KEY:process.env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET:process.env.STRIPE_WEBHOOK_SECRET
  };

  beforeAll(async()=>{
    const org=await pool.query(
      `insert into organizations(organization_type,legal_name,display_name,status)
       values('repair_partner',$1,$1,'active') returning id`,
      [`ROVIQ Pilot Readiness ${Date.now()}-${Math.random()}`]
    );
    orgId=org.rows[0].id;
    const location=await pool.query(
      `insert into locations(organization_id,name,address,latitude,longitude,country_code,region,city,metadata)
       values($1,'Pilot Shop','Pilot acceptance location',45.52,-122.67,'US','OR','Portland','{}'::jsonb)
       returning id`,
      [orgId]
    );
    locationId=location.rows[0].id;
    const connection=await pool.query(
      `insert into partner_system_connections(
        organization_id,location_id,mode,provider_key,display_name,connection_status
       ) values($1,$2,'roviq_native','roviq','ROVIQ Native Pilot','active') returning id`,
      [orgId,locationId]
    );
    connectionId=connection.rows[0].id;

    const bay=await pool.query(
      `insert into service_resources(
        organization_id,location_id,resource_type,display_name,active,source_connection_id,operational_state
       ) values($1,$2,'bay','Pilot Bay',true,$3,'available') returning id`,
      [orgId,locationId,connectionId]
    );
    await pool.query(
      `insert into service_resources(
        organization_id,location_id,resource_type,display_name,active,source_connection_id,operational_state
       ) values($1,$2,'technician','Pilot Technician',true,$3,'available')`,
      [orgId,locationId,connectionId]
    );
    await pool.query(
      `insert into capacity_windows(
        organization_id,location_id,source_connection_id,resource_id,service_category,
        window_start,window_end,capacity_state,capacity_units,nominal_capacity_units,confidence,sync_state
       ) values($1,$2,$3,$4,'repair',now(),now()+interval '8 hours','available',1,1,'roviq_native','current')`,
      [orgId,locationId,connectionId,bay.rows[0].id]
    );
    await pool.query(
      `insert into actors(actor_type,status,organization_id,location_id,attributes)
       values('partner','active',$1,$2,$3)`,
      [orgId,locationId,JSON.stringify({stripeConnectedAccountId:'acct_pilot_test'})]
    );

    const sms=await pool.query(`select * from notification_channel_configs where channel='sms'`);
    previousSms=sms.rows[0]??null;
    await pool.query(
      `insert into notification_channel_configs(channel,provider,enabled,configuration)
       values('sms','twilio',true,'{}'::jsonb)
       on conflict(channel) do update set provider='twilio',enabled=true,configuration='{}'::jsonb,updated_at=now()`
    );
    process.env.TWILIO_ACCOUNT_SID='ACpilot';
    process.env.TWILIO_AUTH_TOKEN='pilot-token';
    process.env.TWILIO_FROM_NUMBER='+15035550000';
    process.env.STRIPE_SECRET_KEY='sk_test_pilot';
    process.env.STRIPE_WEBHOOK_SECRET='whsec_pilot';
  });

  afterAll(async()=>{
    if(previousSms){
      await pool.query(
        `update notification_channel_configs set provider=$1,enabled=$2,configuration=$3,updated_at=$4 where channel='sms'`,
        [previousSms.provider,previousSms.enabled,JSON.stringify(previousSms.configuration??{}),previousSms.updated_at]
      );
    }
    await pool.query('delete from pilot_runs where organization_id=$1',[orgId]).catch(()=>{});
    await pool.query('delete from organizations where id=$1',[orgId]).catch(()=>{});
    for(const [key,value] of Object.entries(previousEnv)){
      if(value===undefined) delete process.env[key];
      else process.env[key]=value;
    }
    await pool.end();
  });

  it('reports ready when the controlled native pilot prerequisites are present',async()=>{
    const result=await getPilotReadiness(admin,{organizationId:orgId,locationId});
    expect(result.ready).toBe(true);
    expect(result.blockerCount).toBe(0);
    expect(result.checks.find((check)=>check.key==='native_connection')?.status).toBe('pass');
    expect(result.checks.find((check)=>check.key==='usable_bay')?.status).toBe('pass');
    expect(result.checks.find((check)=>check.key==='usable_technician')?.status).toBe('pass');
    expect(result.checks.find((check)=>check.key==='future_capacity')?.status).toBe('pass');
    expect(result.checks.find((check)=>check.key==='external_notifications')?.status).toBe('pass');
    expect(result.checks.find((check)=>check.key==='payment_provider')?.status).toBe('pass');
  });


  it('records an auditable ready-to-active-to-completed pilot lifecycle',async()=>{
    const created=await createPilotRun(admin,{organizationId:orgId,locationId});
    expect(created.status).toBe('ready');
    expect(created.readiness_snapshot.ready).toBe(true);

    const started=await startPilotRun(admin,created.id);
    expect(started.status).toBe('active');
    expect(started.started_at).toBeTruthy();

    const completed=await finishPilotRun(admin,created.id,{
      outcome:'completed',
      evidence:{
        scheduling:'passed',
        repairOrder:'passed',
        notifications:'passed',
        payments:'passed',
        reconciliation:'passed'
      }
    });
    expect(completed.status).toBe('completed');
    expect(completed.completed_at).toBeTruthy();
    expect(completed.evidence.scheduling).toBe('passed');

    const events=await pool.query(
      `select event_type from events where aggregate_type='pilot_run' and aggregate_id=$1 order by occurred_at asc`,
      [created.id]
    );
    expect(events.rows.map((row:any)=>row.event_type)).toEqual(['PILOT_READY','PILOT_STARTED','PILOT_COMPLETED']);
  });


  it('keeps scoped admins inside their own pilot organization and location',async()=>{
    const scopedAdminActor=await pool.query(
      `insert into actors(actor_type,status,organization_id,location_id,attributes)
       values('partner','active',$1,$2,'{}'::jsonb) returning id`,
      [orgId,locationId]
    );
    const otherOrg=await pool.query(
      `insert into organizations(organization_type,legal_name,display_name,status)
       values('repair_partner',$1,$1,'active') returning id`,
      [`ROVIQ Other Pilot ${Date.now()}-${Math.random()}`]
    );
    const otherLocation=await pool.query(
      `insert into locations(organization_id,name,address,latitude,longitude,country_code,region,city,metadata)
       values($1,'Other Pilot Shop','Isolation location',45.51,-122.66,'US','OR','Portland','{}'::jsonb)
       returning id`,
      [otherOrg.rows[0].id]
    );
    const scopedAdmin={role:'admin',actorId:scopedAdminActor.rows[0].id} as const;
    await expect(getPilotReadiness(scopedAdmin,{
      organizationId:otherOrg.rows[0].id,
      locationId:otherLocation.rows[0].id
    })).rejects.toMatchObject({message:'forbidden',statusCode:403});
    await pool.query('delete from organizations where id=$1',[otherOrg.rows[0].id]).catch(()=>{});
  });

  it('fails closed when native capacity is removed from the pilot location',async()=>{
    await pool.query(
      `update capacity_windows set capacity_state='blocked',capacity_units=0 where organization_id=$1 and location_id=$2`,
      [orgId,locationId]
    );
    const result=await getPilotReadiness(admin,{organizationId:orgId,locationId});
    expect(result.ready).toBe(false);
    expect(result.checks.find((check)=>check.key==='future_capacity')?.status).toBe('blocker');
    expect(result.nextActions).toContain('At least one current future capacity window with usable units is required');
  });
});
