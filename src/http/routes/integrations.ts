import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { createIntegrationClient, createWebhookSubscription, deliverWebhookBatch } from '../../services/integration-gateway.js';
import { requireRole } from '../middleware/principal.js';

export async function integrationRoutes(app:FastifyInstance) {
  app.post('/api/admin/integrations/clients',{preHandler:requireRole('admin')},async(req,reply)=>{
    const body=z.object({actorId:z.string().uuid(),name:z.string().min(1),scopes:z.array(z.string()).default([])}).parse(req.body);
    return reply.code(201).send(await createIntegrationClient(req.principal,body));
  });

  app.get('/api/admin/integrations/clients',{preHandler:requireRole('admin')},async()=>{
    const r=await pool.query(`select id,actor_id,name,key_prefix,scopes,status,last_used_at,created_at,revoked_at from integration_clients order by created_at desc limit 500`);
    return {clients:r.rows};
  });

  app.post('/api/admin/integrations/webhooks',{preHandler:requireRole('admin')},async(req,reply)=>{
    const body=z.object({actorId:z.string().uuid(),endpointUrl:z.string().url(),eventTypes:z.array(z.string()).default([])}).parse(req.body);
    return reply.code(201).send(await createWebhookSubscription(req.principal,body));
  });

  app.get('/api/admin/integrations/webhooks',{preHandler:requireRole('admin')},async()=>{
    const r=await pool.query(`select id,actor_id,endpoint_url,event_types,status,created_at,updated_at from webhook_subscriptions order by created_at desc limit 500`);
    return {subscriptions:r.rows};
  });

  app.post('/api/admin/integrations/deliver',{preHandler:requireRole('admin')},async(req)=>{
    const body=z.object({limit:z.number().int().positive().max(200).default(50)}).parse(req.body??{});
    return {deliveries:await deliverWebhookBatch(body.limit)};
  });

  app.get('/api/admin/integrations/deliveries',{preHandler:requireRole('admin')},async()=>{
    const r=await pool.query(`select d.*,s.actor_id,s.endpoint_url,e.event_type,e.aggregate_type,e.aggregate_id from webhook_deliveries d join webhook_subscriptions s on s.id=d.subscription_id join integration_events e on e.id=d.integration_event_id order by d.created_at desc limit 500`);
    return {deliveries:r.rows};
  });
}
