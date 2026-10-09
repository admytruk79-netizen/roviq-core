import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { resolveShopPrincipalScope } from './shop-os-scope.js';

type ScopeInput={organizationId?:string;locationId?:string};
function failure(message:string,statusCode:number){return Object.assign(new Error(message),{statusCode})}

export async function assertLocalShopContext(principal:Principal,input:{shopCustomerId?:string|null;shopVehicleId?:string|null},scope:{organizationId:string;locationId:string|null},db:Pick<PoolClient,'query'>){
  if(input.shopVehicleId&&!input.shopCustomerId)throw failure('shop_customer_required',400);
  if(!input.shopCustomerId)return;
  const customer=await db.query(`select id from shop_customers where id=$1 and organization_id=$2 and ($3::uuid is null or location_id=$3)`,[input.shopCustomerId,scope.organizationId,scope.locationId]);
  if(!customer.rowCount)throw failure('shop_customer_not_found',404);
  if(input.shopVehicleId){
    const vehicle=await db.query(`select id from shop_vehicles where id=$1 and shop_customer_id=$2 and organization_id=$3`,[input.shopVehicleId,input.shopCustomerId,scope.organizationId]);
    if(!vehicle.rowCount)throw failure('shop_vehicle_not_found',404);
  }
}

export async function listLocalShopIntake(principal:Principal,input:ScopeInput){
  const scope=await resolveShopPrincipalScope(principal,input,pool);
  const customers=await pool.query(`select id,display_name,email,phone from shop_customers where organization_id=$1 and ($2::uuid is null or location_id=$2) order by display_name,id`,[scope.organizationId,scope.locationId]);
  const vehicles=await pool.query(`select v.* from shop_vehicles v join shop_customers c on c.id=v.shop_customer_id where v.organization_id=$1 and ($2::uuid is null or c.location_id=$2) order by v.created_at desc,v.id`,[scope.organizationId,scope.locationId]);
  return {customers:customers.rows,vehicles:vehicles.rows};
}

export async function createLocalShopIntake(principal:Principal,input:ScopeInput&{displayName:string;email?:string|null;phone?:string|null;vehicle?:{make:string;model:string;modelYear?:number|null;vin?:string|null;licensePlate?:string|null}}){
  const client=await pool.connect();
  try{
    await client.query('begin');
    const scope=await resolveShopPrincipalScope(principal,input,client);
    if(scope.locationId){
      const location=await client.query('select id from locations where id=$1 and organization_id=$2',[scope.locationId,scope.organizationId]);
      if(!location.rowCount)throw failure('shop_location_not_found',404);
    }
    const customer=(await client.query(`insert into shop_customers(organization_id,location_id,display_name,email,phone,created_by_actor_id) values($1,$2,$3,$4,$5,$6) returning *`,[scope.organizationId,scope.locationId,input.displayName.trim(),input.email?.trim()||null,input.phone?.trim()||null,principal.actorId??null])).rows[0];
    let vehicle=null;
    if(input.vehicle){
      const v=input.vehicle;
      vehicle=(await client.query(`insert into shop_vehicles(organization_id,shop_customer_id,make,model,model_year,vin,license_plate) values($1,$2,$3,$4,$5,$6,$7) returning *`,[scope.organizationId,customer.id,v.make.trim(),v.model.trim(),v.modelYear??null,v.vin?.trim().toUpperCase()||null,v.licensePlate?.trim()||null])).rows[0];
    }
    await client.query(`insert into events(aggregate_type,aggregate_id,event_type,actor_id,actor_role,payload) values('shop_customer',$1,'SHOP_OS_LOCAL_INTAKE_CREATED',$2,$3,$4)`,[customer.id,principal.actorId??null,principal.role,JSON.stringify({organizationId:scope.organizationId,vehicleId:vehicle?.id??null})]);
    await client.query('commit');
    return {customer,vehicle};
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
}

export async function addLocalShopVehicle(principal:Principal,customerId:string,input:ScopeInput&{make:string;model:string;modelYear?:number|null;vin?:string|null;licensePlate?:string|null}){
  const client=await pool.connect();
  try{
    await client.query('begin');
    const scope=await resolveShopPrincipalScope(principal,input,client);
    await assertLocalShopContext(principal,{shopCustomerId:customerId},scope,client);
    const vehicle=(await client.query(`insert into shop_vehicles(organization_id,shop_customer_id,make,model,model_year,vin,license_plate) values($1,$2,$3,$4,$5,$6,$7) returning *`,[scope.organizationId,customerId,input.make.trim(),input.model.trim(),input.modelYear??null,input.vin?.trim().toUpperCase()||null,input.licensePlate?.trim()||null])).rows[0];
    await client.query(`insert into events(aggregate_type,aggregate_id,event_type,actor_id,actor_role,payload) values('shop_customer',$1,'SHOP_OS_LOCAL_VEHICLE_ADDED',$2,$3,$4)`,[customerId,principal.actorId??null,principal.role,JSON.stringify({organizationId:scope.organizationId,vehicleId:vehicle.id})]);
    await client.query('commit');
    return {vehicle};
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
}
