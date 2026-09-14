import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { resolveShopPrincipalScope } from './shop-os-scope.js';

const DEFAULT_PAGE_SIZE=200;
const MAX_PAGE_SIZE=500;

export async function listDeferredAppointmentChoices(principal:Principal,input:{organizationId?:string;locationId?:string;afterStart?:string;afterId?:string;limit?:number}){
  const client=await pool.connect();
  try{
    const scope=await resolveShopPrincipalScope(principal,input,client);
    const limit=Math.min(Math.max(input.limit??DEFAULT_PAGE_SIZE,1),MAX_PAGE_SIZE);
    const result=await client.query(`
      select a.*
      from roviq_appointments a
      where a.organization_id=$1
        and ($2::uuid is null or a.location_id=$2::uuid)
        and a.appointment_status in ('held','confirmed')
        and (
          $3::timestamptz is null or
          a.starts_at>$3::timestamptz or
          (a.starts_at=$3::timestamptz and a.id>$4::uuid)
        )
        and exists(
          select 1
          from shop_deferred_service_items d
          join shop_repair_order_lines l on l.id=d.repair_order_line_id
          where d.organization_id=$1
            and ($2::uuid is null or d.location_id=$2::uuid)
            and d.status in ('open','reminded')
            and d.service_case_id is not null
            and d.service_case_id=a.service_case_id
            and (l.service_category is null or a.service_category is null or l.service_category=a.service_category)
        )
      order by a.starts_at,a.id
      limit $5`,[scope.organizationId,scope.locationId,input.afterStart??null,input.afterId??null,limit+1]);
    const hasMore=result.rows.length>limit;
    const appointments=hasMore?result.rows.slice(0,limit):result.rows;
    const last=appointments.at(-1);
    return {
      scope,
      appointments,
      nextCursor:hasMore&&last?{afterStart:last.starts_at,afterId:last.id}:null
    };
  }finally{client.release();}
}
