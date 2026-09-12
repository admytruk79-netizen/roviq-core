import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { resolveShopPrincipalScope } from './shop-os-scope.js';

const MAX_BOARD_RANGE_MS=366*24*60*60*1000;

function httpError(message:string,statusCode:number){
  const error=new Error(message) as Error&{statusCode:number};
  error.statusCode=statusCode;
  return error;
}

export function normalizeShopOsBoardRange(from:string,to:string){
  const requestedStart=new Date(from).getTime();
  const requestedEnd=new Date(to).getTime();
  if(!Number.isFinite(requestedStart)||!Number.isFinite(requestedEnd)||requestedEnd<=requestedStart) throw httpError('shop_os_board_range_invalid',400);
  if(requestedEnd-requestedStart<=MAX_BOARD_RANGE_MS) return {from,to,truncated:false};
  return {from:new Date(requestedEnd-MAX_BOARD_RANGE_MS).toISOString(),to:new Date(requestedEnd).toISOString(),truncated:true};
}

async function resolveBoardScope(principal:Principal,input:{organizationId?:string;locationId?:string}){
  const client=await pool.connect();
  try{return await resolveShopPrincipalScope(principal,input,client);}finally{client.release();}
}

export async function listShopOsBoard(principal:Principal,input:{organizationId?:string;locationId?:string;from:string;to:string}){
  const range=normalizeShopOsBoardRange(input.from,input.to);
  const scope=await resolveBoardScope(principal,input);
  const params=[scope.organizationId,scope.locationId,range.from,range.to];

  const [resources,appointments,capacity,clock]=await Promise.all([
    pool.query(`select r.id,r.organization_id,r.location_id,r.resource_type,r.display_name,r.capability_tags,r.constraints,r.source_connection_id,c.connection_status from service_resources r join partner_system_connections c on c.id=r.source_connection_id and c.mode='roviq_native' where r.organization_id=$1 and ($2::uuid is null or r.location_id=$2::uuid) and r.active=true and c.connection_status not in ('revoked','failed') order by r.resource_type,r.display_name,r.id`,params.slice(0,2)),
    pool.query(`select a.*,recovery.id as active_replacement_appointment_id from roviq_appointments a left join lateral (select replacement.id from roviq_appointments replacement where replacement.recovery_source_appointment_id=a.id and replacement.appointment_status in ('held','confirmed','in_progress','completed') order by replacement.created_at asc,replacement.id asc limit 1) recovery on true where a.organization_id=$1 and ($2::uuid is null or a.location_id=$2::uuid) and a.starts_at<$4::timestamptz and a.ends_at>$3::timestamptz order by a.starts_at,a.resource_id,a.id`,params),
    pool.query(`select cw.* from capacity_windows cw join service_resources r on r.id=cw.resource_id join partner_system_connections c on c.id=cw.source_connection_id and c.mode='roviq_native' where cw.organization_id=$1 and ($2::uuid is null or cw.location_id=$2::uuid or (cw.location_id is null and r.location_id is null)) and cw.window_start<$4::timestamptz and cw.window_end>$3::timestamptz and c.connection_status not in ('revoked','failed') order by cw.window_start,cw.resource_id,cw.id`,params),
    pool.query(`select clock_timestamp() as server_now`)
  ]);

  const statusCounts:Record<string,number>={};
  for(const row of appointments.rows) statusCounts[row.appointment_status]=(statusCounts[row.appointment_status]??0)+1;
  const activeAppointments=appointments.rows.filter((row)=>['held','confirmed','in_progress'].includes(row.appointment_status)).length;
  const byResource=new Map<string,{available:number;nominal:number}>();
  for(const row of capacity.rows){
    const available=Math.max(Number(row.capacity_units??0),0);
    const nominal=Math.max(Number(row.nominal_capacity_units??row.capacity_units??0),0);
    const existing=byResource.get(row.resource_id);
    if(!existing) byResource.set(row.resource_id,{available,nominal});
    else byResource.set(row.resource_id,{available:Math.min(existing.available,available),nominal:Math.max(existing.nominal,nominal)});
  }
  const availableCapacityUnits=[...byResource.values()].reduce((sum,row)=>sum+row.available,0);
  const nominalCapacityUnits=[...byResource.values()].reduce((sum,row)=>sum+row.nominal,0);

  return {scope,range:{from:range.from,to:range.to,requestedFrom:input.from,requestedTo:input.to,truncated:range.truncated},serverNow:clock.rows[0]?.server_now,resources:resources.rows,appointments:appointments.rows,capacity:capacity.rows,summary:{resourceCount:resources.rowCount??resources.rows.length,appointmentCount:appointments.rowCount??appointments.rows.length,activeAppointments,appointmentStatusCounts:statusCounts,availableCapacityUnits,nominalCapacityUnits}};
}
