import { buildPushPayload } from '@block65/webcrypto-web-push';
import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { audit } from './audit.js';

export type DeliveryResult = { success:boolean; providerMessageId?:string; errorCode?:string; errorMessage?:string; response?:Record<string,unknown> };

type Adapter = (input:{ channel:string; recipientId:string; subject?:string; body:string; payload:Record<string,unknown> }) => Promise<DeliveryResult>;

// Twilio credentials are deliberately read from process.env directly (matching how TRIAGE_MODEL_*
// is handled) rather than the strict zod schema in config/env.ts: they're optional, only needed
// once an admin actually enables the 'sms' channel with a real account, and self-hosters who never
// configure SMS shouldn't be forced to set unrelated env vars just to boot Core.
async function sendTwilioSms(recipientId:string, body:string):Promise<DeliveryResult> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  if (!accountSid || !authToken || !fromNumber) {
    return { success:false, errorCode:'twilio_not_configured', errorMessage:'TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_FROM_NUMBER are not set' };
  }
  const actor = await pool.query('select phone from actors where id=$1',[recipientId]);
  const to = actor.rows[0]?.phone as string|undefined;
  if (!to) return { success:false, errorCode:'recipient_phone_missing', errorMessage:'Recipient actor has no phone number on file' };
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const params = new URLSearchParams({ To:to, From:fromNumber, Body:body });
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method:'POST',
    headers:{ authorization:`Basic ${auth}`, 'content-type':'application/x-www-form-urlencoded' },
    body:params.toString()
  });
  const json = await response.json().catch(() => ({})) as Record<string,unknown>;
  if (!response.ok) {
    return { success:false, errorCode:`twilio_http_${response.status}`, errorMessage:typeof json.message === 'string' ? json.message : `Twilio request failed with status ${response.status}`, response:json };
  }
  return { success:true, providerMessageId:typeof json.sid === 'string' ? json.sid : undefined, response:json };
}

// Same reasoning as Twilio above: optional, read directly from process.env, only needed once an
// admin enables the 'email' channel with a real Resend account.
async function sendResendEmail(recipientId:string, subject:string|undefined, body:string):Promise<DeliveryResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !fromEmail) {
    return { success:false, errorCode:'resend_not_configured', errorMessage:'RESEND_API_KEY/RESEND_FROM_EMAIL are not set' };
  }
  const identity = await pool.query(
    `select email from principal_identities where actor_id=$1 and active=true order by created_at asc limit 1`,
    [recipientId]
  );
  const to = identity.rows[0]?.email as string|undefined;
  if (!to) return { success:false, errorCode:'recipient_email_missing', errorMessage:'Recipient actor has no active login email on file' };
  const response = await fetch('https://api.resend.com/emails', {
    method:'POST',
    headers:{ authorization:`Bearer ${apiKey}`, 'content-type':'application/json' },
    body:JSON.stringify({ from:fromEmail, to, subject:subject ?? '(no subject)', text:body })
  });
  const json = await response.json().catch(() => ({})) as Record<string,unknown>;
  if (!response.ok) {
    return { success:false, errorCode:`resend_http_${response.status}`, errorMessage:typeof json.message === 'string' ? json.message : `Resend request failed with status ${response.status}`, response:json };
  }
  return { success:true, providerMessageId:typeof json.id === 'string' ? json.id : undefined, response:json };
}

// Unlike Twilio/Resend, Web Push needs no third-party account -- VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY
// are a self-generated keypair (see migrations/047_push_subscriptions.sql) that identifies this
// server to push services, not a vendor credential. A recipient can have several live subscriptions
// (one per browser/device it enabled push on); this fans out to all of them and reports success if
// any one delivers, deleting subscriptions the push service reports as gone (404/410 -- the
// standard signal a browser unsubscribed or the endpoint expired).
async function sendWebPush(recipientId:string, subject:string|undefined, body:string, payload:Record<string,unknown>):Promise<DeliveryResult> {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const contact = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !contact) {
    return { success:false, errorCode:'webpush_not_configured', errorMessage:'VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VAPID_SUBJECT are not set' };
  }
  const subs = await pool.query('select id,endpoint,p256dh,auth from push_subscriptions where actor_id=$1',[recipientId]);
  if (!subs.rowCount) return { success:false, errorCode:'recipient_not_subscribed', errorMessage:'Recipient actor has no push subscription on file' };

  const vapid = { subject:contact, publicKey, privateKey };
  const data = { title: subject ?? 'ROVIQ update', body, ...payload };
  const outcomes = await Promise.all(subs.rows.map(async (sub) => {
    const subscription = { endpoint:sub.endpoint as string, expirationTime:null, keys:{ p256dh:sub.p256dh as string, auth:sub.auth as string } };
    try {
      const { headers, body:encryptedBody } = await buildPushPayload({ data }, subscription, vapid);
      const response = await fetch(sub.endpoint, { method:'POST', headers, body:encryptedBody as BodyInit });
      if (response.status === 404 || response.status === 410) {
        await pool.query('delete from push_subscriptions where id=$1',[sub.id]);
      }
      return { endpoint:sub.endpoint as string, ok:response.ok, status:response.status };
    } catch (e) {
      return { endpoint:sub.endpoint as string, ok:false, status:0, error:e instanceof Error?e.message:'send_failed' };
    }
  }));
  const success = outcomes.some((o) => o.ok);
  return {
    success,
    providerMessageId: success ? `webpush:${recipientId}:${Date.now()}` : undefined,
    errorCode: success ? undefined : 'webpush_delivery_failed',
    errorMessage: success ? undefined : 'No subscribed device accepted the push',
    response: { outcomes }
  };
}

const adapters: Record<string,Adapter> = {
  internal: async ({ recipientId }) => ({ success:true, providerMessageId:`internal:${recipientId}:${Date.now()}` }),
  twilio: async ({ recipientId, body }) => sendTwilioSms(recipientId, body),
  resend: async ({ recipientId, subject, body }) => sendResendEmail(recipientId, subject, body),
  webpush: async ({ recipientId, subject, body, payload }) => sendWebPush(recipientId, subject, body, payload)
};

function render(template:string, payload:Record<string,unknown>) {
  return template.replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_m,key) => {
    const value = payload[key];
    return value == null ? '' : String(value);
  });
}

export async function processNotificationBatch(principal: Principal, workerId:string, limit=50) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const claimed = await client.query(
      `with candidates as (
         select id from notification_outbox
         where state='pending' and available_at<=now() and (locked_at is null or locked_at < now()-interval '5 minutes')
         order by created_at asc
         for update skip locked
         limit $1
       )
       update notification_outbox n set locked_at=now(),locked_by=$2
       from candidates c where n.id=c.id returning n.*`, [limit,workerId]
    );
    await client.query('commit');

    const results: unknown[] = [];
    for (const n of claimed.rows) {
      results.push(await deliverOne(principal,n,workerId));
    }
    return results;
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally { client.release(); }
}

async function deliverOne(principal: Principal, notification:any, workerId:string) {
  const attemptNumber = Number(notification.attempt_count ?? 0) + 1;
  const dead = attemptNumber >= Number(notification.max_attempts ?? 5);
  const config = await pool.query('select * from notification_channel_configs where channel=$1',[notification.channel]);
  const provider = notification.provider || config.rows[0]?.provider || 'internal';
  if (!config.rowCount || !config.rows[0].enabled) {
    await fail(notification,'channel_disabled','Notification channel is disabled',provider,workerId,attemptNumber);
    return { id:notification.id, state: dead ? 'dead' : 'retry' };
  }

  const templateResult = await pool.query(
    `select * from notification_templates where template_key=$1 and channel=$2 and active=true order by version desc limit 1`,
    [notification.template_key,notification.channel]
  );
  const template = templateResult.rows[0];
  const payload = notification.payload ?? {};
  const subject = template?.subject_template ? render(template.subject_template,payload) : undefined;
  const body = template?.body_template ? render(template.body_template,payload) : JSON.stringify(payload);
  const adapter = adapters[provider];
  if (!adapter) {
    await fail(notification,'provider_not_configured',`No adapter registered for ${provider}`,provider,workerId,attemptNumber);
    return { id:notification.id, state: dead ? 'dead' : 'retry' };
  }

  let result:DeliveryResult;
  try {
    result = await adapter({ channel:notification.channel,recipientId:notification.recipient_id,subject,body,payload });
  } catch (e) {
    result = { success:false,errorCode:'adapter_exception',errorMessage:e instanceof Error?e.message:'adapter_exception' };
  }

  await pool.query(
    `insert into notification_delivery_attempts(notification_id,attempt_number,provider,provider_message_id,state,error_code,error_message,request_payload,response_payload)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [notification.id,attemptNumber,provider,result.providerMessageId ?? null,result.success?'sent':'failed',result.errorCode ?? null,result.errorMessage ?? null,JSON.stringify({ subject,body,recipientId:notification.recipient_id }),JSON.stringify(result.response ?? {})]
  );

  if (result.success) {
    await pool.query(
      `update notification_outbox set state='sent',attempt_count=$1,provider=$2,provider_message_id=$3,sent_at=now(),locked_at=null,locked_by=null,last_error=null where id=$4`,
      [attemptNumber,provider,result.providerMessageId ?? null,notification.id]
    );
    await audit(principal,'notification_sent','notification',notification.id,provider,{ channel:notification.channel,templateKey:notification.template_key });
    return { id:notification.id,state:'sent',providerMessageId:result.providerMessageId };
  }

  await retryOrDead(notification,attemptNumber,result,provider,workerId);
  return { id:notification.id, state: dead ? 'dead' : 'retry' };
}

async function fail(notification:any, code:string, message:string, provider:string, workerId:string, attemptNumber:number) {
  await pool.query(
    `insert into notification_delivery_attempts(notification_id,attempt_number,provider,state,error_code,error_message)
     values($1,$2,$3,'failed',$4,$5)`, [notification.id,attemptNumber,provider,code,message]
  );
  await retryOrDead(notification,attemptNumber,{ success:false,errorCode:code,errorMessage:message },provider,workerId);
}

async function retryOrDead(notification:any, attemptNumber:number, result:DeliveryResult, provider:string, _workerId:string) {
  const dead = attemptNumber >= Number(notification.max_attempts ?? 5);
  const delaySeconds = Math.min(3600, Math.pow(2,Math.max(0,attemptNumber-1))*30);
  await pool.query(
    `update notification_outbox set state=$1,attempt_count=$2,provider=$3,last_error=$4,
     available_at=case when $1='pending' then now()+($5 || ' seconds')::interval else available_at end,
     locked_at=null,locked_by=null where id=$6`,
    [dead?'dead':'pending',attemptNumber,provider,result.errorMessage ?? result.errorCode ?? 'delivery_failed',String(delaySeconds),notification.id]
  );
}

export async function upsertNotificationTemplate(principal:Principal,input:{ templateKey:string;channel:string;subjectTemplate?:string;bodyTemplate:string;active?:boolean;metadata?:Record<string,unknown> }) {
  const current = await pool.query('select coalesce(max(version),0)+1 as next_version from notification_templates where template_key=$1 and channel=$2',[input.templateKey,input.channel]);
  const r = await pool.query(
    `insert into notification_templates(template_key,channel,subject_template,body_template,active,version,metadata)
     values($1,$2,$3,$4,$5,$6,$7) returning *`,
    [input.templateKey,input.channel,input.subjectTemplate ?? null,input.bodyTemplate,input.active ?? true,current.rows[0].next_version,JSON.stringify(input.metadata ?? {})]
  );
  await audit(principal,'create_notification_template','notification_template',r.rows[0].id,'admin_template_update',{ templateKey:input.templateKey,channel:input.channel,version:r.rows[0].version });
  return r.rows[0];
}

export async function setChannelConfig(principal:Principal,input:{ channel:string;provider:string;enabled:boolean;configuration?:Record<string,unknown> }) {
  const r = await pool.query(
    `insert into notification_channel_configs(channel,provider,enabled,configuration,updated_at)
     values($1,$2,$3,$4,now()) on conflict(channel) do update set provider=excluded.provider,enabled=excluded.enabled,configuration=excluded.configuration,updated_at=now() returning *`,
    [input.channel,input.provider,input.enabled,JSON.stringify(input.configuration ?? {})]
  );
  await audit(principal,'set_notification_channel','notification_channel',input.channel,'admin_channel_config',{ provider:input.provider,enabled:input.enabled });
  return r.rows[0];
}


export async function getNotificationDeliverySummary(input:{
  organizationId?:string|null;
  locationId?:string|null;
}={}){
  const organizationId=input.organizationId??null;
  const locationId=input.locationId??null;
  const scopeSql=`
    (
      $1::uuid is null
      or exists(
        select 1
        from service_cases sc
        left join actors owner on owner.id=sc.current_owner_actor_id
        left join actors selected on selected.id=sc.selected_actor_id
        left join actors recommended on recommended.id=sc.recommended_actor_id
        where sc.id=n.case_id and (
          owner.organization_id=$1::uuid
          or selected.organization_id=$1::uuid
          or recommended.organization_id=$1::uuid
        ) and (
          $2::uuid is null
          or owner.location_id=$2::uuid
          or selected.location_id=$2::uuid
          or recommended.location_id=$2::uuid
        )
      )
      or exists(
        select 1 from actors recipient
        where recipient.id::text=n.recipient_id
          and recipient.organization_id=$1::uuid
          and ($2::uuid is null or recipient.location_id=$2::uuid)
      )
    )`;
  const counts=await pool.query(`
    select
      count(*) filter(where n.state='pending' and coalesce(n.attempt_count,0)=0)::int as queued,
      count(*) filter(where n.state='pending' and coalesce(n.attempt_count,0)>0)::int as retrying,
      count(*) filter(where n.state='sent')::int as delivered,
      count(*) filter(where n.state='dead')::int as failed,
      count(*) filter(where n.state='pending' and n.locked_at is not null and n.locked_at>=now()-interval '5 minutes')::int as processing
    from notification_outbox n
    where ${scopeSql}`,[organizationId,locationId]);

  const failures=await pool.query(`
    select n.id,n.case_id,n.channel,n.recipient_type,n.recipient_id,n.template_key,n.attempt_count,n.max_attempts,
           n.last_error,n.available_at,n.created_at
      from notification_outbox n
     where ${scopeSql}
       and n.state='dead'
     order by n.created_at desc
     limit 100`,[organizationId,locationId]);

  const row=counts.rows[0]??{};
  return {
    scope:{organizationId,locationId},
    states:{
      queued:Number(row.queued??0),
      retrying:Number(row.retrying??0),
      processing:Number(row.processing??0),
      delivered:Number(row.delivered??0),
      failed:Number(row.failed??0)
    },
    failures:failures.rows
  };
}

export async function requeueFailedNotification(principal:Principal,notificationId:string){
  const client=await pool.connect();
  try{
    await client.query('begin');
    const current=await client.query(
      `select * from notification_outbox where id=$1 for update`,
      [notificationId]
    );
    if(!current.rowCount) {
      const error=new Error('notification_not_found') as Error&{statusCode:number};
      error.statusCode=404;
      throw error;
    }
    const row=current.rows[0];
    if(row.state!=='dead'){
      const error=new Error('notification_not_failed') as Error&{statusCode:number};
      error.statusCode=409;
      throw error;
    }
    const updated=await client.query(
      `update notification_outbox
          set state='pending',
              max_attempts=greatest(max_attempts,coalesce(attempt_count,0)+3),
              available_at=now(),
              locked_at=null,
              locked_by=null,
              last_error=null
        where id=$1
        returning *`,
      [notificationId]
    );
    await client.query('commit');
    await audit(principal,'notification_requeued','notification',notificationId,'manual_delivery_recovery',{
      previousAttemptCount:Number(row.attempt_count??0),
      maxAttempts:Number(updated.rows[0].max_attempts??0),
      channel:row.channel,
      caseId:row.case_id??null
    });
    return updated.rows[0];
  }catch(error){
    await client.query('rollback').catch(()=>{});
    throw error;
  }finally{
    client.release();
  }
}
