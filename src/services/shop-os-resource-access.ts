import type { Principal } from '../types/principal.js';
import { assertShopPrincipalScope } from './shop-os-scope.js';
import { httpError, type Queryable } from './shop-os-scheduling-rules.js';

export async function loadManageableShopOsResource(principal:Principal,resourceId:string,db:Queryable){
  const resource=await db.query(`
    select r.*,c.id as shop_os_connection_id,c.connection_status
    from service_resources r
    join partner_system_connections c
      on c.id=r.source_connection_id
     and c.mode='roviq_native'
     and c.connection_status='active'
    where r.id=$1 and r.active=true
      and r.operational_state not in ('blocked','offline')
    limit 1`,[resourceId]);
  if(!resource.rowCount) throw httpError('shop_os_resource_not_found',404);
  const row=resource.rows[0];
  await assertShopPrincipalScope(principal,row.organization_id,row.location_id,db);
  return row;
}

export async function loadExistingShopOsResource(principal:Principal,resourceId:string,db:Queryable){
  const resource=await db.query(`
    select r.*,c.id as shop_os_connection_id,c.connection_status
    from service_resources r
    left join partner_system_connections c
      on c.id=r.source_connection_id and c.mode='roviq_native'
    where r.id=$1
    limit 1`,[resourceId]);
  if(!resource.rowCount) throw httpError('shop_os_resource_not_found',404);
  const row=resource.rows[0];
  await assertShopPrincipalScope(principal,row.organization_id,row.location_id,db);
  return row;
}
