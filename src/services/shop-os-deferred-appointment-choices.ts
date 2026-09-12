import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { resolveShopPrincipalScope } from './shop-os-scope.js';

const MAX_CHOICES=500;

export async function listDeferredAppointmentChoices(principal:Principal,input:{organizationId?:string;locationId?:string}){
  const client=await pool.connect();
  try{
    const scope=await resolveShopPrincipalScope(principal,input,client);
    const result=await client.query(`
      select a.*
      from roviq_appointments a
      where a.organization_id=$1
        and ($2::uuid is null or a.location_id=$2::uuid)
        and a.appointment_status in ('held','confirmed')
        and a.ends_at>=now()-interval '1 day'
        and a.starts_at<now()+interval '365 days'
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
      limit $3`,[scope.organizationId,scope.locationId,MAX_CHOICES]);
    return {scope,appointments:result.rows};
  }finally{client.release();}
}
