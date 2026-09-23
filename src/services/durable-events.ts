import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';

export type OutboxMessage={
  id:string; aggregate_type:string; aggregate_id:string; event_type:string;
  payload:Record<string,unknown>; correlation_id:string; attempts:number;
};
type Queryable=Pick<PoolClient,'query'>;

export async function claimOutboxBatch(limit=50,db:Queryable=pool){
  const bounded=Math.max(1,Math.min(limit,200));
  const r=await db.query<OutboxMessage>(`
    with claimed as (
      select id from core_outbox
      where published_at is null and available_at<=now()
      order by available_at,created_at
      for update skip locked
      limit $1
    )
    update core_outbox o
       set attempts=o.attempts+1,
           available_at=now()+interval '5 minutes'
      from claimed c
     where o.id=c.id
     returning o.id,o.aggregate_type,o.aggregate_id,o.event_type,o.payload,o.correlation_id,o.attempts
  `,[bounded]);
  return r.rows;
}

export async function markOutboxPublished(id:string,db:Queryable=pool){
  await db.query('update core_outbox set published_at=now(),last_error=null where id=$1 and published_at is null',[id]);
}
export async function markOutboxFailed(id:string,error:unknown,db:Queryable=pool){
  const message=error instanceof Error?error.message:String(error);
  await db.query(`update core_outbox
    set last_error=left($2,2000),
        available_at=now() + (least(greatest(attempts,1),8) * interval '30 seconds')
    where id=$1 and published_at is null`,[id,message]);
}

export async function receiveConnectorEvent(input:{
  connectorKey:string; externalEventId:string; eventType:string; payload:Record<string,unknown>;
},db:Queryable=pool){
  const r=await db.query(`insert into core_connector_inbox(connector_key,external_event_id,event_type,payload)
    values($1,$2,$3,$4)
    on conflict(connector_key,external_event_id) do nothing
    returning *`,[input.connectorKey,input.externalEventId,input.eventType,input.payload]);
  if(r.rowCount)return {duplicate:false,event:r.rows[0]};
  const existing=await db.query('select * from core_connector_inbox where connector_key=$1 and external_event_id=$2',[input.connectorKey,input.externalEventId]);
  return {duplicate:true,event:existing.rows[0]};
}

export async function processInboxEvent(id:string,handler:(event:any,client:PoolClient)=>Promise<void>){
  const client=await pool.connect();
  try{
    await client.query('begin');
    const r=await client.query('select * from core_connector_inbox where id=$1 for update',[id]);
    if(!r.rowCount){await client.query('rollback');return {status:'missing' as const};}
    const event=r.rows[0];
    if(event.status==='processed'||event.status==='ignored'){await client.query('commit');return {status:event.status as 'processed'|'ignored'};}
    try{
      await handler(event,client);
      await client.query(`update core_connector_inbox set status='processed',processed_at=now(),error=null where id=$1`,[id]);
      await client.query('commit');return {status:'processed' as const};
    }catch(error){
      await client.query('rollback');
      await pool.query(`update core_connector_inbox set status='failed',error=left($2,2000) where id=$1 and status not in ('processed','ignored')`,[id,error instanceof Error?error.message:String(error)]);
      throw error;
    }
  }finally{client.release();}
}
