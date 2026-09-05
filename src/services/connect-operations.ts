import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { audit } from './audit.js';

export type ConnectHealth = 'healthy'|'attention'|'degraded'|'paused'|'failed'|'revoked'|'planned';
export type CredentialState = 'unknown'|'configured'|'valid'|'expiring'|'expired'|'revoked'|'error';
export type AccessState = 'unknown'|'authorized'|'limited'|'denied'|'revoked';
export type ConnectionStatus = 'planned'|'active'|'paused'|'degraded'|'revoked'|'failed';
export type FallbackMode = 'none'|'bridge'|'manual';

export function deriveConnectHealth(input:{
  connectionStatus:ConnectionStatus;
  credentialState:CredentialState;
  accessState:AccessState;
  lastSuccessAt?:string|Date|null;
  now?:Date;
  mode:'native_integration'|'roviq_native'|'bridge';
  fallbackEnabled?:boolean;
  fallbackMode?:FallbackMode;
}):{health:ConnectHealth;reasons:string[];fallbackActive:boolean}{
  const reasons:string[]=[];
  const fallbackActive=!!input.fallbackEnabled && input.fallbackMode !== 'none';
  if(input.connectionStatus==='revoked') return {health:'revoked',reasons:['connection_revoked'],fallbackActive:false};
  if(input.connectionStatus==='failed') return {health:'failed',reasons:['connection_failed'],fallbackActive};
  if(input.connectionStatus==='paused') return {health:'paused',reasons:['connection_paused'],fallbackActive};
  if(input.connectionStatus==='planned') return {health:'planned',reasons:['connection_planned'],fallbackActive:false};

  if(['expired','revoked','error'].includes(input.credentialState)) reasons.push(`credential_${input.credentialState}`);
  else if(['unknown','expiring'].includes(input.credentialState) && input.mode==='native_integration') reasons.push(`credential_${input.credentialState}`);

  if(['denied','revoked'].includes(input.accessState)) reasons.push(`access_${input.accessState}`);
  else if(['unknown','limited'].includes(input.accessState) && input.mode==='native_integration') reasons.push(`access_${input.accessState}`);

  if(input.mode==='native_integration') {
    if(!input.lastSuccessAt) reasons.push('sync_never_succeeded');
    else {
      const now=input.now ?? new Date();
      const age=now.getTime()-new Date(input.lastSuccessAt).getTime();
      if(!Number.isFinite(age) || age>60*60*1000) reasons.push('sync_degraded');
      else if(age>15*60*1000) reasons.push('sync_stale');
    }
  }

  if(input.connectionStatus==='degraded' || reasons.some((r)=>['credential_expired','credential_revoked','credential_error','access_denied','access_revoked','sync_degraded'].includes(r))) {
    return {health:'degraded',reasons,fallbackActive};
  }
  if(reasons.length) return {health:'attention',reasons,fallbackActive};
  return {health:'healthy',reasons:[],fallbackActive};
}

export async function listConnectConnections(){
  const r=await pool.query(`
    select c.*,o.name as organization_name,l.name as location_name,
      (select count(*)::int from integration_sync_events e where e.connection_id=c.id and e.status='failed' and e.created_at>now()-interval '24 hours') as failures_24h,
      (select max(e.created_at) from integration_sync_events e where e.connection_id=c.id) as latest_event_at
    from partner_system_connections c
    left join organizations o on o.id=c.organization_id
    left join locations l on l.id=c.location_id
    order by c.updated_at desc,c.created_at desc
    limit 500`);
  return r.rows.map((row:any)=>({
    ...row,
    operational:deriveConnectHealth({
      connectionStatus:row.connection_status,
      credentialState:row.credential_state,
      accessState:row.access_state,
      lastSuccessAt:row.last_success_at,
      mode:row.mode,
      fallbackEnabled:row.fallback_enabled,
      fallbackMode:row.fallback_mode
    })
  }));
}

function assertAdmin(principal:Principal){ if(principal.role!=='admin') throw new Error('forbidden'); }

export async function setConnectionControl(principal:Principal,connectionId:string,input:{
  action:'activate'|'pause'|'degrade'|'fail'|'revoke';
  reason?:string|null;
  fallbackEnabled?:boolean;
  fallbackMode?:FallbackMode;
}){
  assertAdmin(principal);
  const client=await pool.connect();
  try{
    await client.query('begin');
    const current=await client.query(`select * from partner_system_connections where id=$1 for update`,[connectionId]);
    if(!current.rowCount) throw new Error('connection_not_found');
    const row=current.rows[0];
    if(row.connection_status==='revoked' && input.action!=='revoke') throw new Error('connection_revoked_terminal');
    const status:ConnectionStatus=input.action==='activate'?'active':input.action==='pause'?'paused':input.action==='degrade'?'degraded':input.action==='fail'?'failed':'revoked';
    const fallbackMode=input.fallbackMode ?? row.fallback_mode ?? 'none';
    const fallbackEnabled=input.fallbackEnabled ?? row.fallback_enabled ?? false;
    if(fallbackEnabled && fallbackMode==='none') throw new Error('fallback_mode_required');
    const updated=await client.query(`
      update partner_system_connections
      set connection_status=$1,status_reason=$2,fallback_enabled=$3,fallback_mode=$4,
          paused_at=case when $1='paused' then now() else paused_at end,
          revoked_at=case when $1='revoked' then now() else revoked_at end,
          updated_at=now()
      where id=$5 returning *`,[status,input.reason??null,fallbackEnabled,fallbackMode,connectionId]);
    await client.query(`insert into integration_sync_events(connection_id,event_type,direction,status,payload)
      values($1,'connection_control','internal','accepted',$2)`,[connectionId,JSON.stringify({action:input.action,status,reason:input.reason??null,fallbackEnabled,fallbackMode})]);
    await client.query('commit');
    await audit(principal,'set_connection_control','partner_system_connection',connectionId,'roviq_connect_operations',{action:input.action,status,reason:input.reason??null,fallbackEnabled,fallbackMode});
    return updated.rows[0];
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}

export async function reportConnectionHealth(principal:Principal,connectionId:string,input:{
  outcome:'success'|'failure'|'heartbeat';
  credentialState?:CredentialState;
  accessState?:AccessState;
  error?:string|null;
  eventType?:string;
  direction?:'inbound'|'outbound'|'internal';
}){
  assertAdmin(principal);
  const client=await pool.connect();
  try{
    await client.query('begin');
    const current=await client.query(`select * from partner_system_connections where id=$1 for update`,[connectionId]);
    if(!current.rowCount) throw new Error('connection_not_found');
    const row=current.rows[0];
    if(row.connection_status==='revoked') throw new Error('connection_revoked_terminal');
    const credentialState=input.credentialState ?? row.credential_state;
    const accessState=input.accessState ?? row.access_state;
    const success=input.outcome==='success';
    const failure=input.outcome==='failure';
    const nextStatus:ConnectionStatus=failure?'degraded':row.connection_status==='planned'&&success?'active':row.connection_status==='failed'&&success?'active':row.connection_status;
    const updated=await client.query(`
      update partner_system_connections
      set connection_status=$1,credential_state=$2,access_state=$3,health_checked_at=now(),last_sync_at=now(),
          last_success_at=case when $4 then now() else last_success_at end,
          last_failure_at=case when $5 then now() else last_failure_at end,
          last_error=case when $5 then $6 when $4 then null else last_error end,
          status_reason=case when $5 then coalesce($6,'sync_failure') when $4 then null else status_reason end,
          updated_at=now()
      where id=$7 returning *`,[nextStatus,credentialState,accessState,success,failure,input.error??null,connectionId]);
    await client.query(`insert into integration_sync_events(connection_id,event_type,direction,status,error_message,payload)
      values($1,$2,$3,$4,$5,$6)`,[
      connectionId,input.eventType??'connection_health',input.direction??'internal',failure?'failed':'accepted',input.error??null,
      JSON.stringify({outcome:input.outcome,credentialState,accessState})
    ]);
    await client.query('commit');
    await audit(principal,'report_connection_health','partner_system_connection',connectionId,'roviq_connect_health',{outcome:input.outcome,credentialState,accessState});
    return {...updated.rows[0],operational:deriveConnectHealth({
      connectionStatus:updated.rows[0].connection_status,
      credentialState:updated.rows[0].credential_state,
      accessState:updated.rows[0].access_state,
      lastSuccessAt:updated.rows[0].last_success_at,
      mode:updated.rows[0].mode,
      fallbackEnabled:updated.rows[0].fallback_enabled,
      fallbackMode:updated.rows[0].fallback_mode
    })};
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}
