import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { audit } from './audit.js';

const hashKey = (key:string) => createHash('sha256').update(key).digest('hex');

export async function createIntegrationClient(principal:Principal,input:{actorId:string;name:string;scopes:string[]}) {
  if (principal.role !== 'admin') throw new Error('forbidden');
  const raw = `rvq_${randomBytes(24).toString('base64url')}`;
  const prefix = raw.slice(0,12);
  const r = await pool.query(
    `insert into integration_clients(actor_id,name,key_prefix,key_hash,scopes) values($1,$2,$3,$4,$5) returning id,actor_id,name,key_prefix,scopes,status,created_at`,
    [input.actorId,input.name,prefix,hashKey(raw),input.scopes]
  );
  await audit(principal,'create_integration_client','integration_client',r.rows[0].id,'actor_gateway',{ actorId:input.actorId, scopes:input.scopes });
  return { client:r.rows[0], apiKey:raw };
}

export async function authenticateIntegrationKey(raw:string) {
  const prefix = raw.slice(0,12);
  const r = await pool.query('select * from integration_clients where key_prefix=$1 and status=\'active\' limit 1',[prefix]);
  if (!r.rowCount) return null;
  const expected = Buffer.from(r.rows[0].key_hash,'hex');
  const actual = Buffer.from(hashKey(raw),'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected,actual)) return null;
  await pool.query('update integration_clients set last_used_at=now() where id=$1',[r.rows[0].id]);
  return r.rows[0];
}

export async function createWebhookSubscription(principal:Principal,input:{actorId:string;endpointUrl:string;eventTypes:string[]}) {
  if (principal.role !== 'admin') throw new Error('forbidden');
  const secret = randomBytes(32).toString('base64url');
  const r = await pool.query(
    `insert into webhook_subscriptions(actor_id,endpoint_url,secret,event_types) values($1,$2,$3,$4) returning id,actor_id,endpoint_url,event_types,status,created_at`,
    [input.actorId,input.endpointUrl,secret,input.eventTypes]
  );
  await audit(principal,'create_webhook_subscription','webhook_subscription',r.rows[0].id,'actor_gateway',{ actorId:input.actorId });
  return { subscription:r.rows[0], signingSecret:secret };
}

export async function publishIntegrationEvent(input:{aggregateType:string;aggregateId?:string;eventType:string;actorId?:string;payload?:Record<string,unknown>}) {
  const event = await pool.query(
    `insert into integration_events(aggregate_type,aggregate_id,event_type,actor_id,payload) values($1,$2,$3,$4,$5) returning *`,
    [input.aggregateType,input.aggregateId ?? null,input.eventType,input.actorId ?? null,JSON.stringify(input.payload ?? {})]
  );
  const e = event.rows[0];
  // A webhook_subscriptions row is scoped to one actor, but nothing here previously checked that
  // actor actually has any relationship to the case the event is about -- an event-type filter
  // with an empty event_types array (or one that just lists this eventType) would fan every
  // matching event, for every case on the platform, out to that one subscriber. Restrict delivery
  // to subscribers with a genuine relation to the event's case, mirroring the same relation set
  // loadCaseForPrincipal already uses to gate reads of the same data. Only enforced when a real
  // aggregateId is supplied -- a service_case event published without one (as generic pub/sub
  // mechanics tests do) has no case to scope against, so it falls back to the event-type filter.
  await pool.query(
    `insert into webhook_deliveries(subscription_id,integration_event_id)
     select s.id,$1 from webhook_subscriptions s
     where s.status='active' and (cardinality(s.event_types)=0 or $2 = any(s.event_types))
       and (
         $3::text is distinct from 'service_case' or $4::uuid is null
         or exists (
           select 1 from service_cases c
           where c.id=$4::uuid
             and (
               c.customer_actor_id=s.actor_id
               or c.current_owner_actor_id=s.actor_id
               or exists(select 1 from matches_offers mo where mo.case_id=c.id and mo.actor_id=s.actor_id)
               or exists(select 1 from transport_dispatches td where td.case_id=c.id and td.provider_actor_id=s.actor_id)
               or exists(select 1 from parts_orders po where po.case_id=c.id and po.supplier_actor_id=s.actor_id)
               or exists(select 1 from mobility_allocations ma where ma.case_id=c.id and ma.provider_actor_id=s.actor_id)
             )
         )
       )
     on conflict do nothing`,[e.id,input.eventType,input.aggregateType,input.aggregateId ?? null]
  );
  return e;
}

export async function deliverWebhookBatch(limit=50) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const r = await client.query(
      `select d.*,s.endpoint_url,s.secret,e.event_type,e.aggregate_type,e.aggregate_id,e.actor_id,e.payload,e.occurred_at
       from webhook_deliveries d join webhook_subscriptions s on s.id=d.subscription_id join integration_events e on e.id=d.integration_event_id
       where d.state in ('pending','retry') and d.available_at<=now() order by d.created_at asc for update skip locked limit $1`,[limit]
    );
    const ids = r.rows.map((x:any)=>x.id);
    if (ids.length) await client.query(`update webhook_deliveries set state='processing' where id=any($1::uuid[])`,[ids]);
    await client.query('commit');
    const results:any[]=[];
    for (const d of r.rows) {
      const body = JSON.stringify({ id:d.integration_event_id,type:d.event_type,aggregate:{type:d.aggregate_type,id:d.aggregate_id},actorId:d.actor_id,payload:d.payload,occurredAt:d.occurred_at });
      const ts = Math.floor(Date.now()/1000).toString();
      const sig = createHmac('sha256',d.secret).update(`${ts}.${body}`).digest('hex');
      try {
        const resp = await fetch(d.endpoint_url,{method:'POST',headers:{'content-type':'application/json','x-roviq-event-id':d.integration_event_id,'x-roviq-timestamp':ts,'x-roviq-signature':`v1=${sig}`},body});
        if (resp.ok) {
          await pool.query(`update webhook_deliveries set state='delivered',attempt_count=attempt_count+1,response_code=$1,delivered_at=now() where id=$2`,[resp.status,d.id]);
          results.push({id:d.id,state:'delivered'});
        } else throw new Error(`http_${resp.status}`);
      } catch (e) {
        const attempt = d.attempt_count + 1;
        const dead = attempt >= 8;
        const delaySec = Math.min(3600,Math.pow(2,attempt)*15);
        await pool.query(`update webhook_deliveries set state=$1,attempt_count=$2,last_error=$3,available_at=now()+($4||' seconds')::interval where id=$5`,[dead?'dead':'retry',attempt,String(e instanceof Error?e.message:e),delaySec,d.id]);
        results.push({id:d.id,state:dead?'dead':'retry'});
      }
    }
    return results;
  } catch (e) { await client.query('rollback'); throw e; } finally { client.release(); }
}
