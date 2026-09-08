import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { createIntegrationClient, createWebhookSubscription, deliverWebhookBatch } from '../../services/integration-gateway.js';
import { listConnectConnections, reportConnectionHealth, setConnectionControl } from '../../services/connect-operations.js';
import { requireRole } from '../middleware/principal.js';
import type { Principal } from '../../types/principal.js';

function connectError(reply:any,error:unknown){
  if(error instanceof Error&&error.message==='connection_not_found') return reply.code(404).send({error:error.message});
  if(error instanceof Error&&error.message==='fallback_mode_required') return reply.code(400).send({error:error.message});
  if(error instanceof Error&&error.message==='connection_revoked_terminal') return reply.code(409).send({error:error.message});
  if(error instanceof Error&&error.message==='forbidden') return reply.code(403).send({error:error.message});
  throw error;
}

function httpError(message:string,statusCode:number){
  const error=new Error(message) as Error&{statusCode:number};
  error.statusCode=statusCode;
  return error;
}

type AdminScope={organizationId:string;locationId:string|null}|null;

async function resolveAdminScope(principal:Principal):Promise<AdminScope>{
  if(principal.role!=='admin') throw httpError('forbidden',403);
  if(!principal.actorId) return null;
  const actor=await pool.query(`select organization_id,location_id,status from actors where id=$1`,[principal.actorId]);
  if(!actor.rowCount||actor.rows[0].status!=='active'||!actor.rows[0].organization_id) throw httpError('forbidden',403);
  return {organizationId:actor.rows[0].organization_id,locationId:actor.rows[0].location_id??null};
}

async function assertTargetActorScope(principal:Principal,actorId:string){
  const scope=await resolveAdminScope(principal);
  if(!scope)return;
  const actor=await pool.query(`select organization_id,location_id,status from actors where id=$1`,[actorId]);
  if(!actor.rowCount||actor.rows[0].status!=='active') throw httpError('actor_not_found',404);
  if(actor.rows[0].organization_id!==scope.organizationId) throw httpError('forbidden',403);
  if(scope.locationId&&actor.rows[0].location_id!==scope.locationId) throw httpError('forbidden',403);
}

async function assertAdminConnectionScope(principal:Principal,connectionId:string){
  const connection=await pool.query(`select id,organization_id,location_id from partner_system_connections where id=$1`,[connectionId]);
  if(!connection.rowCount) throw httpError('connection_not_found',404);
  const scope=await resolveAdminScope(principal);
  if(!scope)return connection.rows[0];
  const row=connection.rows[0];
  if(scope.organizationId!==row.organization_id) throw httpError('forbidden',403);
  if(scope.locationId&&scope.locationId!==row.location_id) throw httpError('forbidden',403);
  return row;
}

export async function integrationRoutes(app:FastifyInstance) {
  app.post('/api/admin/integrations/clients',{preHandler:requireRole('admin')},async(req,reply)=>{
    const body=z.object({actorId:z.string().uuid(),name:z.string().min(1),scopes:z.array(z.string()).default([])}).parse(req.body);
    await assertTargetActorScope(req.principal,body.actorId);
    return reply.code(201).send(await createIntegrationClient(req.principal,body));
  });

  app.get('/api/admin/integrations/clients',{preHandler:requireRole('admin')},async(req)=>{
    const scope=await resolveAdminScope(req.principal);
    const r=await pool.query(`select ic.id,ic.actor_id,ic.name,ic.key_prefix,ic.scopes,ic.status,ic.last_used_at,ic.created_at,ic.revoked_at
      from integration_clients ic
      join actors a on a.id=ic.actor_id
      where ($1::uuid is null or a.organization_id=$1::uuid)
        and ($2::uuid is null or a.location_id=$2::uuid)
      order by ic.created_at desc limit 500`,[scope?.organizationId??null,scope?.locationId??null]);
    return {clients:r.rows};
  });

  app.get('/api/admin/integrations/connections',{preHandler:requireRole('admin')},async(req,reply)=>{
    try{return {connections:await listConnectConnections(req.principal)};}catch(error){return connectError(reply,error);}
  });

  app.patch('/api/admin/integrations/connections/:id/control',{preHandler:requireRole('admin')},async(req,reply)=>{
    const {id}=z.object({id:z.string().uuid()}).parse(req.params);
    const body=z.object({
      action:z.enum(['activate','pause','degrade','fail','revoke']),
      reason:z.string().max(500).nullable().optional(),
      fallbackEnabled:z.boolean().optional(),
      fallbackMode:z.enum(['none','bridge','manual']).optional()
    }).parse(req.body);
    try{return {connection:await setConnectionControl(req.principal,id,body)};}catch(error){return connectError(reply,error);}
  });

  app.post('/api/admin/integrations/connections/:id/health',{preHandler:requireRole('admin')},async(req,reply)=>{
    const {id}=z.object({id:z.string().uuid()}).parse(req.params);
    const body=z.object({
      outcome:z.enum(['success','failure','heartbeat']),
      credentialState:z.enum(['unknown','configured','valid','expiring','expired','revoked','error']).optional(),
      accessState:z.enum(['unknown','authorized','limited','denied','revoked']).optional(),
      error:z.string().max(2000).nullable().optional(),
      eventType:z.string().min(1).max(120).optional(),
      direction:z.enum(['inbound','outbound','internal']).optional()
    }).parse(req.body);
    try{return {connection:await reportConnectionHealth(req.principal,id,body)};}catch(error){return connectError(reply,error);}
  });

  app.get('/api/admin/integrations/connections/:id/events',{preHandler:requireRole('admin')},async(req)=>{
    const {id}=z.object({id:z.string().uuid()}).parse(req.params);
    await assertAdminConnectionScope(req.principal,id);
    const r=await pool.query(`select id,event_type,direction,status,correlation_id,external_entity_type,external_entity_id,roviq_entity_type,roviq_entity_id,error_message,created_at from integration_sync_events where connection_id=$1 order by created_at desc limit 250`,[id]);
    return {events:r.rows};
  });

  app.post('/api/admin/integrations/webhooks',{preHandler:requireRole('admin')},async(req,reply)=>{
    const body=z.object({actorId:z.string().uuid(),endpointUrl:z.string().url(),eventTypes:z.array(z.string()).default([])}).parse(req.body);
    await assertTargetActorScope(req.principal,body.actorId);
    return reply.code(201).send(await createWebhookSubscription(req.principal,body));
  });

  app.get('/api/admin/integrations/webhooks',{preHandler:requireRole('admin')},async(req)=>{
    const scope=await resolveAdminScope(req.principal);
    const r=await pool.query(`select s.id,s.actor_id,s.endpoint_url,s.event_types,s.status,s.created_at,s.updated_at
      from webhook_subscriptions s
      join actors a on a.id=s.actor_id
      where ($1::uuid is null or a.organization_id=$1::uuid)
        and ($2::uuid is null or a.location_id=$2::uuid)
      order by s.created_at desc limit 500`,[scope?.organizationId??null,scope?.locationId??null]);
    return {subscriptions:r.rows};
  });

  app.post('/api/admin/integrations/deliver',{preHandler:requireRole('admin')},async(req,reply)=>{
    const scope=await resolveAdminScope(req.principal);
    if(scope)return reply.code(403).send({error:'global_delivery_admin_only'});
    const body=z.object({limit:z.number().int().positive().max(200).default(50)}).parse(req.body??{});
    return {deliveries:await deliverWebhookBatch(body.limit)};
  });

  app.get('/api/admin/integrations/deliveries',{preHandler:requireRole('admin')},async(req)=>{
    const scope=await resolveAdminScope(req.principal);
    const r=await pool.query(`select d.*,s.actor_id,s.endpoint_url,e.event_type,e.aggregate_type,e.aggregate_id
      from webhook_deliveries d
      join webhook_subscriptions s on s.id=d.subscription_id
      join actors a on a.id=s.actor_id
      join integration_events e on e.id=d.integration_event_id
      where ($1::uuid is null or a.organization_id=$1::uuid)
        and ($2::uuid is null or a.location_id=$2::uuid)
      order by d.created_at desc limit 500`,[scope?.organizationId??null,scope?.locationId??null]);
    return {deliveries:r.rows};
  });
}
