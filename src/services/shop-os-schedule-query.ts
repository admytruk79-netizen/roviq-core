import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { loadExistingShopOsResource } from './shop-os-resource-access.js';

export async function listShopOsSchedule(principal:Principal,input:{resourceId:string;from:string;to:string}){
  const client=await pool.connect();
  try{
    await loadExistingShopOsResource(principal,input.resourceId,client);
    const appointments=await client.query(`select * from roviq_appointments
      where resource_id=$1 and starts_at<$3 and ends_at>$2
      order by starts_at asc,id asc`,[input.resourceId,input.from,input.to]);
    const capacity=await client.query(`select * from capacity_windows
      where resource_id=$1 and window_start<$3 and window_end>$2
      order by window_start asc,id asc`,[input.resourceId,input.from,input.to]);
    return {appointments:appointments.rows,capacity:capacity.rows};
  }finally{
    client.release();
  }
}
