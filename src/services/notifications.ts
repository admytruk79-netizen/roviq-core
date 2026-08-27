import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { audit } from './audit.js';

export type DeliveryResult = { success:boolean; providerMessageId?:string; errorCode?:string; errorMessage?:string; response?:Record<string,unknown> };

type Adapter = (input:{ channel:string; recipientId:string; subject?:string; body:string; payload:Record<string,unknown> }) => Promise<DeliveryResult>;

const adapters: Record<string,Adapter> = {
  internal: async ({ recipientId }) => ({ success:true, providerMessageId:`internal:${recipientId}:${Date.now()}` })
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
