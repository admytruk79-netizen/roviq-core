import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { getPilotReadiness } from '../src/services/pilot-readiness.js';
import { createPaymentIntent } from '../src/services/payment-core.js';
import { requeueFailedNotification } from '../src/services/notifications.js';
import { addPilotRunCase, createPilotRun, finishPilotRun, getPilotRunHealth, getPilotRunMetrics, startPilotRun } from '../src/services/pilot-runs.js';

const admin={role:'admin'} as const;

async function addCanonicalCompletionTruth(caseId:string){
  const plan=await pool.query(
    `insert into fulfillment_plans(
       service_case_id,version,status,blockers,dependency_snapshot
     ) values($1,1,'completed','[]'::jsonb,'{}'::jsonb) returning id`,
    [caseId]
  );
  await pool.query(
    `insert into completion_outcomes(
       service_case_id,fulfillment_plan_id,outcome,dependency_snapshot,evidence
     ) values($1,$2,'completed','{}'::jsonb,$3)`,
    [caseId,plan.rows[0].id,JSON.stringify({source:'pilot_acceptance_test'})]
  );
}

describe('controlled Shop OS pilot readiness gate',()=>{
  let orgId:string;
  let locationId:string;
  let connectionId:string;
  let partnerActorId:string;
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
    const partnerActor=await pool.query(
      `insert into actors(actor_type,status,organization_id,location_id,attributes)
       values('partner','active',$1,$2,$3) returning id`,
      [orgId,locationId,JSON.stringify({stripeConnectedAccountId:'acct_pilot_test'})]
    );
    partnerActorId=partnerActor.rows[0].id;

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

    const domain=await pool.query(`select id from domains where code='maintenance' limit 1`);
    const serviceCase=await pool.query(
      `insert into service_cases(domain_id,location_id,state,current_owner_role,current_owner_actor_id,completed_at)
       values($1,$2,'completed','partner',$3,now()) returning id`,
      [domain.rows[0].id,locationId,partnerActorId]
    );
    await addPilotRunCase(admin,created.id,serviceCase.rows[0].id);
    await addCanonicalCompletionTruth(serviceCase.rows[0].id);

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




  it('revalidates connector and capacity health immediately before pilot start',async()=>{
    const created=await createPilotRun(admin,{organizationId:orgId,locationId});

    await pool.query(
      `update partner_system_connections set connection_status='degraded',updated_at=now() where id=$1`,
      [connectionId]
    );
    await expect(startPilotRun(admin,created.id))
      .rejects.toMatchObject({message:'pilot_readiness_blocked',statusCode:409});

    await pool.query(
      `update partner_system_connections set connection_status='active',updated_at=now() where id=$1`,
      [connectionId]
    );
    await pool.query(
      `update capacity_windows set sync_state='stale',updated_at=now() where organization_id=$1 and location_id=$2`,
      [orgId,locationId]
    );
    await expect(startPilotRun(admin,created.id))
      .rejects.toMatchObject({message:'pilot_readiness_blocked',statusCode:409});

    await pool.query(
      `update capacity_windows set sync_state='current',capacity_state='available',capacity_units=1,updated_at=now()
        where organization_id=$1 and location_id=$2`,
      [orgId,locationId]
    );
    const started=await startPilotRun(admin,created.id);
    expect(started.status).toBe('active');

    const aborted=await finishPilotRun(admin,created.id,{
      outcome:'aborted',
      abortReason:'Acceptance test verified fail-closed start revalidation.'
    });
    expect(aborted.status).toBe('aborted');
  });


  it('detects an active-pilot resource failure without declaring the run healthy',async()=>{
    const created=await createPilotRun(admin,{organizationId:orgId,locationId});
    await startPilotRun(admin,created.id);

    const before=await getPilotRunHealth(admin,created.id);
    expect(['healthy','attention']).toContain(before.status);

    await pool.query(
      `update service_resources
          set operational_state='offline',updated_at=now()
        where organization_id=$1 and location_id=$2 and resource_type='technician'`,
      [orgId,locationId]
    );
    const degraded=await getPilotRunHealth(admin,created.id);
    expect(degraded.status).toBe('degraded');
    expect(degraded.readiness?.checks.find((check)=>check.key==='usable_technician')?.status).toBe('blocker');

    await pool.query(
      `update service_resources
          set operational_state='available',updated_at=now()
        where organization_id=$1 and location_id=$2 and resource_type='technician'`,
      [orgId,locationId]
    );
    const aborted=await finishPilotRun(admin,created.id,{
      outcome:'aborted',
      abortReason:'Acceptance test verified live resource-failure detection.'
    });
    expect(aborted.status).toBe('aborted');
  });


  it('degrades a live pilot when a linked case has a dead customer notification',async()=>{
    const created=await createPilotRun(admin,{organizationId:orgId,locationId});
    await startPilotRun(admin,created.id);

    const domain=await pool.query(`select id from domains where code='maintenance' limit 1`);
    const serviceCase=await pool.query(
      `insert into service_cases(domain_id,location_id,state,current_owner_role,current_owner_actor_id)
       values($1,$2,'repair_in_progress','partner',$3) returning id`,
      [domain.rows[0].id,locationId,partnerActorId]
    );
    await addPilotRunCase(admin,created.id,serviceCase.rows[0].id);
    await pool.query(
      `insert into notification_outbox(
         case_id,channel,recipient_type,recipient_id,template_key,payload,state,attempt_count,max_attempts,last_error
       ) values($1,'sms','actor',$2,'pilot_failure','{}'::jsonb,'dead',5,5,'provider_down')`,
      [serviceCase.rows[0].id,partnerActorId]
    );

    const health=await getPilotRunHealth(admin,created.id);
    expect(health.status).toBe('degraded');
    expect(health.operational.notifications.dead).toBe(1);

    const aborted=await finishPilotRun(admin,created.id,{
      outcome:'aborted',
      abortReason:'Acceptance test verified linked notification failure detection.'
    });
    expect(aborted.status).toBe('aborted');
  });



  it('moves a dead linked notification from degraded to recoverable retry state',async()=>{
    const created=await createPilotRun(admin,{organizationId:orgId,locationId});
    await startPilotRun(admin,created.id);

    const domain=await pool.query(`select id from domains where code='maintenance' limit 1`);
    const serviceCase=await pool.query(
      `insert into service_cases(domain_id,location_id,state,current_owner_role,current_owner_actor_id)
       values($1,$2,'repair_in_progress','partner',$3) returning id`,
      [domain.rows[0].id,locationId,partnerActorId]
    );
    await addPilotRunCase(admin,created.id,serviceCase.rows[0].id);
    await addCanonicalCompletionTruth(serviceCase.rows[0].id);
    const notification=await pool.query(
      `insert into notification_outbox(
         case_id,channel,recipient_type,recipient_id,template_key,payload,state,attempt_count,max_attempts,last_error
       ) values($1,'sms','actor',$2,'pilot_recovery','{}'::jsonb,'dead',5,5,'provider_down')
       returning id`,
      [serviceCase.rows[0].id,partnerActorId]
    );

    const degraded=await getPilotRunHealth(admin,created.id);
    expect(degraded.status).toBe('degraded');
    expect(degraded.operational.notifications.dead).toBe(1);

    await requeueFailedNotification(admin,notification.rows[0].id);
    const retrying=await getPilotRunHealth(admin,created.id);
    expect(retrying.status).toBe('attention');
    expect(retrying.operational.notifications.dead).toBe(0);
    expect(retrying.operational.notifications.retrying).toBe(1);

    await pool.query(
      `update notification_outbox
          set state='sent',sent_at=now(),attempt_count=6,last_error=null,locked_at=null,locked_by=null
        where id=$1`,
      [notification.rows[0].id]
    );
    const recovered=await getPilotRunHealth(admin,created.id);
    expect(recovered.operational.notifications.dead).toBe(0);
    expect(recovered.operational.notifications.retrying).toBe(0);

    const aborted=await finishPilotRun(admin,created.id,{
      outcome:'aborted',
      abortReason:'Acceptance test verified notification recovery state transitions.'
    });
    expect(aborted.status).toBe('aborted');
  });

  it('degrades a live pilot when a linked case has a failed payment-provider event',async()=>{
    const created=await createPilotRun(admin,{organizationId:orgId,locationId});
    await startPilotRun(admin,created.id);

    const domain=await pool.query(`select id from domains where code='maintenance' limit 1`);
    const serviceCase=await pool.query(
      `insert into service_cases(domain_id,location_id,state,current_owner_role,current_owner_actor_id)
       values($1,$2,'payment_pending','partner',$3) returning id`,
      [domain.rows[0].id,locationId,partnerActorId]
    );
    await addPilotRunCase(admin,created.id,serviceCase.rows[0].id);
    const payment=await createPaymentIntent(admin,{
      caseId:serviceCase.rows[0].id,
      amount:75,
      currency:'USD',
      provider:'stripe',
      providerIntentId:`pi-pilot-failure-${Date.now()}-${Math.random()}`
    });
    await pool.query(
      `insert into payment_provider_events(
         provider,provider_event_id,event_type,processing_state,related_payment_intent_id,error_message,payload
       ) values('stripe',$1,'payment_intent.payment_failed','failed',$2,'provider_timeout','{}'::jsonb)`,
      [`evt-pilot-failure-${Date.now()}-${Math.random()}`,payment.id]
    );

    const health=await getPilotRunHealth(admin,created.id);
    expect(health.status).toBe('degraded');
    expect(health.operational.paymentProviderEvents.failed).toBe(1);

    const aborted=await finishPilotRun(admin,created.id,{
      outcome:'aborted',
      abortReason:'Acceptance test verified linked payment-provider failure detection.'
    });
    expect(aborted.status).toBe('aborted');
  });


  it('surfaces open disputes as attention and failed partner settlements as degraded',async()=>{
    const created=await createPilotRun(admin,{organizationId:orgId,locationId});
    await startPilotRun(admin,created.id);

    const domain=await pool.query(`select id from domains where code='maintenance' limit 1`);
    const serviceCase=await pool.query(
      `insert into service_cases(domain_id,location_id,state,current_owner_role,current_owner_actor_id)
       values($1,$2,'payment_pending','partner',$3) returning id`,
      [domain.rows[0].id,locationId,partnerActorId]
    );
    await addPilotRunCase(admin,created.id,serviceCase.rows[0].id);
    const payment=await createPaymentIntent(admin,{
      caseId:serviceCase.rows[0].id,
      amount:40,
      currency:'USD',
      provider:'stripe',
      providerIntentId:`pi-pilot-dispute-${Date.now()}-${Math.random()}`
    });
    const dispute=await pool.query(
      `insert into payment_disputes(
         payment_intent_id,provider,external_reference,status,amount_minor,currency,reason
       ) values($1,'stripe',$2,'needs_response',1000,'USD','fraudulent') returning id`,
      [payment.id,`dp-pilot-${Date.now()}-${Math.random()}`]
    );

    const attention=await getPilotRunHealth(admin,created.id);
    expect(attention.status).toBe('attention');
    expect(attention.operational.disputes.open).toBe(1);

    await pool.query(
      `update payment_disputes set status='won',resolved_at=now() where id=$1`,
      [dispute.rows[0].id]
    );
    await pool.query(
      `insert into settlement_payouts(
         case_id,counterparty_actor_id,payment_intent_id,amount,currency,state,provider
       ) values($1,$2,$3,10,'USD','failed','stripe')`,
      [serviceCase.rows[0].id,partnerActorId,payment.id]
    );

    const degraded=await getPilotRunHealth(admin,created.id);
    expect(degraded.status).toBe('degraded');
    expect(degraded.operational.disputes.open).toBe(0);
    expect(degraded.operational.settlements.failed).toBe(1);

    const aborted=await finishPilotRun(admin,created.id,{
      outcome:'aborted',
      abortReason:'Acceptance test verified dispute and settlement health signals.'
    });
    expect(aborted.status).toBe('aborted');
  });


  it('reports scoped pilot operating metrics from linked canonical cases',async()=>{
    const created=await createPilotRun(admin,{organizationId:orgId,locationId});
    await startPilotRun(admin,created.id);

    const domain=await pool.query(`select id from domains where code='maintenance' limit 1`);
    const serviceCase=await pool.query(
      `insert into service_cases(domain_id,location_id,state,current_owner_role,current_owner_actor_id)
       values($1,$2,'repair_in_progress','partner',$3) returning id`,
      [domain.rows[0].id,locationId,partnerActorId]
    );
    await addPilotRunCase(admin,created.id,serviceCase.rows[0].id);
    await pool.query(
      `insert into notification_outbox(
         case_id,channel,recipient_type,recipient_id,template_key,payload,state,attempt_count,max_attempts
       ) values($1,'sms','actor',$2,'pilot_metrics','{}'::jsonb,'sent',1,5)`,
      [serviceCase.rows[0].id,partnerActorId]
    );
    await pool.query(
      `insert into transport_dispatches(case_id,transport_type,status)
       values($1,'tow','delivered')`,
      [serviceCase.rows[0].id]
    );

    const metrics=await getPilotRunMetrics(admin,created.id);
    expect(metrics.cases.total).toBe(1);
    expect(metrics.notifications.total).toBe(1);
    expect(metrics.notifications.delivered).toBe(1);
    expect(metrics.transport.total).toBe(1);
    expect(metrics.transport.delivered).toBe(1);

    const aborted=await finishPilotRun(admin,created.id,{
      outcome:'aborted',
      abortReason:'Acceptance test verified pilot metrics aggregation.'
    });
    expect(aborted.status).toBe('aborted');
  });

  it('refuses to complete a pilot without a linked completed canonical case',async()=>{
    const created=await createPilotRun(admin,{organizationId:orgId,locationId});
    await startPilotRun(admin,created.id);
    await expect(finishPilotRun(admin,created.id,{
      outcome:'completed',
      evidence:{scheduling:'passed'}
    })).rejects.toMatchObject({message:'pilot_case_required',statusCode:409});
    const aborted=await finishPilotRun(admin,created.id,{
      outcome:'aborted',
      abortReason:'Acceptance test verified missing-case completion gate.'
    });
    expect(aborted.status).toBe('aborted');
  });


  it('rejects API attempts to complete a pilot with partial evidence',async()=>{
    const created=await createPilotRun(admin,{organizationId:orgId,locationId});
    await startPilotRun(admin,created.id);

    const domain=await pool.query(`select id from domains where code='maintenance' limit 1`);
    const serviceCase=await pool.query(
      `insert into service_cases(domain_id,location_id,state,current_owner_role,current_owner_actor_id,completed_at)
       values($1,$2,'completed','partner',$3,now()) returning id`,
      [domain.rows[0].id,locationId,partnerActorId]
    );
    await addPilotRunCase(admin,created.id,serviceCase.rows[0].id);

    await expect(finishPilotRun(admin,created.id,{
      outcome:'completed',
      evidence:{scheduling:'passed'}
    })).rejects.toMatchObject({
      message:'pilot_evidence_incomplete',
      statusCode:409,
      missingEvidence:expect.arrayContaining(['repairOrder','notifications','payments','reconciliation'])
    });

    const aborted=await finishPilotRun(admin,created.id,{
      outcome:'aborted',
      abortReason:'Acceptance test verified incomplete-evidence completion is rejected.'
    });
    expect(aborted.status).toBe('aborted');
  });



  it('blocks completion when a completed case lacks canonical fulfillment completion truth',async()=>{
    const created=await createPilotRun(admin,{organizationId:orgId,locationId});
    await startPilotRun(admin,created.id);

    const domain=await pool.query(`select id from domains where code='maintenance' limit 1`);
    const serviceCase=await pool.query(
      `insert into service_cases(domain_id,location_id,state,current_owner_role,current_owner_actor_id,completed_at)
       values($1,$2,'completed','partner',$3,now()) returning id`,
      [domain.rows[0].id,locationId,partnerActorId]
    );
    await addPilotRunCase(admin,created.id,serviceCase.rows[0].id);
    const evidence={
      scheduling:'passed',
      repairOrder:'passed',
      notifications:'passed',
      payments:'passed',
      reconciliation:'passed'
    };

    await expect(finishPilotRun(admin,created.id,{outcome:'completed',evidence}))
      .rejects.toMatchObject({
        message:'pilot_operational_blockers',
        statusCode:409,
        blockers:expect.arrayContaining([
          expect.objectContaining({kind:'completion_truth_missing',caseId:serviceCase.rows[0].id})
        ])
      });

    const aborted=await finishPilotRun(admin,created.id,{
      outcome:'aborted',
      abortReason:'Acceptance test verified canonical completion truth is mandatory.'
    });
    expect(aborted.status).toBe('aborted');
  });

  it('blocks pilot completion while linked operational failures remain unresolved',async()=>{
    const created=await createPilotRun(admin,{organizationId:orgId,locationId});
    await startPilotRun(admin,created.id);

    const domain=await pool.query(`select id from domains where code='maintenance' limit 1`);
    const serviceCase=await pool.query(
      `insert into service_cases(domain_id,location_id,state,current_owner_role,current_owner_actor_id,completed_at)
       values($1,$2,'completed','partner',$3,now()) returning id`,
      [domain.rows[0].id,locationId,partnerActorId]
    );
    await addPilotRunCase(admin,created.id,serviceCase.rows[0].id);
    const notification=await pool.query(
      `insert into notification_outbox(
         case_id,channel,recipient_type,recipient_id,template_key,payload,state,attempt_count,max_attempts,last_error
       ) values($1,'sms','actor',$2,'pilot_completion_blocker','{}'::jsonb,'dead',5,5,'provider_down')
       returning id`,
      [serviceCase.rows[0].id,partnerActorId]
    );
    const evidence={
      scheduling:'passed',
      repairOrder:'passed',
      notifications:'passed',
      payments:'passed',
      reconciliation:'passed'
    };

    await expect(finishPilotRun(admin,created.id,{outcome:'completed',evidence}))
      .rejects.toMatchObject({
        message:'pilot_operational_blockers',
        statusCode:409,
        blockers:expect.arrayContaining([
          expect.objectContaining({kind:'notification_delivery',id:notification.rows[0].id})
        ])
      });

    await pool.query(
      `update notification_outbox
          set state='sent',sent_at=now(),last_error=null,locked_at=null,locked_by=null
        where id=$1`,
      [notification.rows[0].id]
    );
    await addCanonicalCompletionTruth(serviceCase.rows[0].id);
    const completed=await finishPilotRun(admin,created.id,{outcome:'completed',evidence});
    expect(completed.status).toBe('completed');
  });


  it('prevents scoped admins from attaching an unrelated tenant case to a pilot run',async()=>{
    const created=await createPilotRun(admin,{organizationId:orgId,locationId});
    const scopedAdminActor=await pool.query(
      `insert into actors(actor_type,status,organization_id,location_id,attributes)
       values('partner','active',$1,$2,'{}'::jsonb) returning id`,
      [orgId,locationId]
    );
    const scopedAdmin={role:'admin',actorId:scopedAdminActor.rows[0].id} as const;

    const otherOrg=await pool.query(
      `insert into organizations(organization_type,display_name,status)
       values('repair_partner',$1,'active') returning id`,
      [`Foreign Pilot Tenant ${Date.now()}-${Math.random()}`]
    );
    const otherLocation=await pool.query(
      `insert into locations(organization_id,name,country_code,region,city)
       values($1,'Foreign Shop','US','OR','Portland') returning id`,
      [otherOrg.rows[0].id]
    );
    const domain=await pool.query(`select id from domains where code='maintenance' limit 1`);
    const foreignCase=await pool.query(
      `insert into service_cases(domain_id,location_id,case_type,state)
       values($1,$2,'maintenance','provider_selection') returning id`,
      [domain.rows[0].id,otherLocation.rows[0].id]
    );

    await expect(addPilotRunCase(scopedAdmin,created.id,foreignCase.rows[0].id))
      .rejects.toMatchObject({message:'pilot_case_scope_mismatch',statusCode:409});

    const cases=await pool.query(`select service_case_id from pilot_run_cases where pilot_run_id=$1`,[created.id]);
    expect(cases.rowCount).toBe(0);

    await finishPilotRun(admin,created.id,{
      outcome:'aborted',
      abortReason:'Acceptance test verified tenant isolation on pilot case membership.'
    });
    await pool.query('delete from organizations where id=$1',[otherOrg.rows[0].id]).catch(()=>{});
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
