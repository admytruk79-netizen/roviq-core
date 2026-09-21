import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { getAdminActorScope } from './admin-case-scope.js';

type PilotCheck={
  key:string;
  status:'pass'|'blocker'|'warning';
  message:string;
  evidence?:Record<string,unknown>;
};

function add(checks:PilotCheck[],key:string,ok:boolean,message:string,evidence?:Record<string,unknown>,severity:'blocker'|'warning'='blocker'){
  checks.push({key,status:ok?'pass':severity,message,evidence});
}

function externalNotificationConfigured(provider:string){
  if(provider==='twilio') return Boolean(process.env.TWILIO_ACCOUNT_SID&&process.env.TWILIO_AUTH_TOKEN&&process.env.TWILIO_FROM_NUMBER);
  if(provider==='resend') return Boolean(process.env.RESEND_API_KEY&&process.env.RESEND_FROM_EMAIL);
  if(provider==='webpush') return Boolean(process.env.VAPID_PUBLIC_KEY&&process.env.VAPID_PRIVATE_KEY&&process.env.VAPID_SUBJECT);
  return false;
}

export async function getPilotReadiness(principal:Principal,input:{organizationId?:string;locationId?:string}){
  if(principal.role!=='admin') throw Object.assign(new Error('forbidden'),{statusCode:403});
  const scope=await getAdminActorScope(principal,pool);
  const organizationId=scope?.organizationId??input.organizationId??null;
  const locationId=scope?.locationId??input.locationId??null;

  if(!organizationId) throw Object.assign(new Error('pilot_organization_required'),{statusCode:400});
  if(scope?.organizationId&&input.organizationId&&scope.organizationId!==input.organizationId) throw Object.assign(new Error('forbidden'),{statusCode:403});
  if(scope?.locationId&&input.locationId&&scope.locationId!==input.locationId) throw Object.assign(new Error('forbidden'),{statusCode:403});

  const checks:PilotCheck[]=[];

  const organization=await pool.query(
    `select id,display_name,status from organizations where id=$1`,
    [organizationId]
  );
  add(checks,'organization_active',Boolean(organization.rows[0]?.status==='active'),'Pilot organization must exist and be active',{
    organizationId,
    displayName:organization.rows[0]?.display_name??null,
    status:organization.rows[0]?.status??null
  });
  if(!organization.rowCount) return finalize(checks,{organizationId,locationId});

  if(locationId){
    const location=await pool.query(
      `select id,name,organization_id from locations where id=$1`,
      [locationId]
    );
    add(checks,'location_owned',Boolean(location.rows[0]?.organization_id===organizationId),'Pilot location must belong to the selected organization',{
      locationId,
      name:location.rows[0]?.name??null
    });
  }else{
    add(checks,'location_selected',false,'A concrete location is required for a controlled Shop OS pilot',{organizationId});
  }

  const connection=await pool.query(
    `select id,connection_status,mode,last_sync_at,last_success_at,last_error
       from partner_system_connections
      where organization_id=$1
        and ($2::uuid is null or location_id=$2::uuid)
        and mode='roviq_native'
      order by case when connection_status='active' then 0 else 1 end,created_at asc
      limit 1`,
    [organizationId,locationId]
  );
  const connectionRow=connection.rows[0];
  add(checks,'native_connection',Boolean(connectionRow?.connection_status==='active'),'An active ROVIQ-native Shop OS connection is required',{
    connectionId:connectionRow?.id??null,
    status:connectionRow?.connection_status??null,
    lastSyncAt:connectionRow?.last_sync_at??null,
    lastSuccessAt:connectionRow?.last_success_at??null,
    lastError:connectionRow?.last_error??null
  });

  const resources=await pool.query(
    `select
       count(*) filter(where active=true)::int as active_total,
       count(*) filter(where active=true and resource_type='bay' and operational_state not in ('blocked','offline'))::int as usable_bays,
       count(*) filter(where active=true and resource_type='technician' and operational_state not in ('blocked','offline'))::int as usable_technicians,
       count(*) filter(where active=true and operational_state in ('blocked','offline'))::int as unavailable
     from service_resources
     where organization_id=$1
       and ($2::uuid is null or location_id=$2::uuid)`,
    [organizationId,locationId]
  );
  const resourceRow=resources.rows[0]??{};
  add(checks,'usable_bay',Number(resourceRow.usable_bays??0)>0,'At least one active usable service bay is required',{count:Number(resourceRow.usable_bays??0)});
  add(checks,'usable_technician',Number(resourceRow.usable_technicians??0)>0,'At least one active usable technician resource is required',{count:Number(resourceRow.usable_technicians??0)});
  add(checks,'resource_fail_closed',Number(resourceRow.unavailable??0)===0,'Blocked/offline resources are present; confirm they are intentionally unavailable',{
    unavailable:Number(resourceRow.unavailable??0),
    activeTotal:Number(resourceRow.active_total??0)
  },'warning');

  const capacity=await pool.query(
    `select
       count(*) filter(
         where sync_state='current'
           and capacity_state in ('available','limited')
           and capacity_units>0
           and window_end>now()
       )::int as usable_future,
       count(*) filter(where sync_state in ('stale','degraded','failed'))::int as degraded
     from capacity_windows
     where organization_id=$1
       and ($2::uuid is null or location_id=$2::uuid)`,
    [organizationId,locationId]
  );
  const capacityRow=capacity.rows[0]??{};
  add(checks,'future_capacity',Number(capacityRow.usable_future??0)>0,'At least one current future capacity window with usable units is required',{
    usableFuture:Number(capacityRow.usable_future??0),
    degraded:Number(capacityRow.degraded??0)
  });
  add(checks,'capacity_health',Number(capacityRow.degraded??0)===0,'Stale/degraded capacity exists and must be reviewed before pilot traffic',{
    degraded:Number(capacityRow.degraded??0)
  },'warning');

  const notificationConfigs=await pool.query(
    `select channel,provider,enabled from notification_channel_configs where enabled=true`
  );
  const externalChannels=notificationConfigs.rows.filter((row:any)=>externalNotificationConfigured(String(row.provider)));
  add(checks,'external_notifications',externalChannels.length>0,'At least one enabled, externally configured notification provider is required',{
    configured:externalChannels.map((row:any)=>({channel:row.channel,provider:row.provider}))
  });

  const stripeConfigured=Boolean(process.env.STRIPE_SECRET_KEY&&process.env.STRIPE_WEBHOOK_SECRET);
  add(checks,'payment_provider',stripeConfigured,'Stripe API and webhook credentials must be configured for payment truth',{
    stripeSecretConfigured:Boolean(process.env.STRIPE_SECRET_KEY),
    stripeWebhookConfigured:Boolean(process.env.STRIPE_WEBHOOK_SECRET)
  });

  const partnerActors=await pool.query(
    `select id,actor_type,attributes
       from actors
      where organization_id=$1
        and ($2::uuid is null or location_id=$2::uuid)
        and status='active'
        and actor_type in ('partner','shop','repair_shop','service_provider','dealer','dealership')`,
    [organizationId,locationId]
  );
  const payoutReady=partnerActors.rows.some((row:any)=>{
    const attributes=row.attributes??{};
    const account=attributes.stripeConnectedAccountId??attributes.stripe_connected_account_id;
    return typeof account==='string'&&account.startsWith('acct_');
  });
  add(checks,'partner_settlement_destination',payoutReady,'No Stripe Connect destination is configured for the pilot partner; partner payouts cannot execute',{
    candidateActors:partnerActors.rowCount??0
  },'warning');

  const openOperational=await pool.query(
    `select
       (select count(*)::int
          from case_exceptions ce
          join service_cases sc on sc.id=ce.case_id
          left join actors owner on owner.id=sc.current_owner_actor_id
          left join actors selected on selected.id=sc.selected_actor_id
         where ce.state='open'
           and (owner.organization_id=$1 or selected.organization_id=$1)
           and ($2::uuid is null or owner.location_id=$2::uuid or selected.location_id=$2::uuid)
       ) as open_exceptions,
       (select count(*)::int
          from webhook_deliveries wd
          join webhook_subscriptions ws on ws.id=wd.subscription_id
          join actors wa on wa.id=ws.actor_id
         where wd.state='dead'
           and wa.organization_id=$1
           and ($2::uuid is null or wa.location_id=$2::uuid)
       ) as dead_webhooks`,
    [organizationId,locationId]
  );
  const operationalRow=openOperational.rows[0]??{};
  add(checks,'operational_exceptions',Number(operationalRow.open_exceptions??0)===0,'Open pilot-scope operational exceptions should be cleared before go-live',{
    open:Number(operationalRow.open_exceptions??0)
  },'warning');
  add(checks,'webhook_dead_letters',Number(operationalRow.dead_webhooks??0)===0,'Dead webhook deliveries exist for the pilot organization',{
    dead:Number(operationalRow.dead_webhooks??0)
  },'warning');

  return finalize(checks,{organizationId,locationId});
}

function finalize(checks:PilotCheck[],scope:{organizationId:string;locationId:string|null}){
  const blockers=checks.filter((check)=>check.status==='blocker');
  const warnings=checks.filter((check)=>check.status==='warning');
  return {
    scope,
    generatedAt:new Date().toISOString(),
    ready:blockers.length===0,
    blockerCount:blockers.length,
    warningCount:warnings.length,
    checks,
    nextActions:blockers.map((check)=>check.message)
  };
}
