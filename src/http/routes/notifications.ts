import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { requireRole } from '../middleware/principal.js';
import { processNotificationBatch, setChannelConfig, upsertNotificationTemplate } from '../../services/notifications.js';
import { getAdminActorScope } from '../../services/admin-case-scope.js';

const notificationScopePredicate=`(
  exists(
    select 1
    from service_cases sc
    left join actors owner on owner.id=sc.current_owner_actor_id
    left join actors selected on selected.id=sc.selected_actor_id
    left join actors recommended on recommended.id=sc.recommended_actor_id
    where sc.id=n.case_id and (
      (owner.organization_id=$1 and ($2::uuid is null or owner.location_id=$2))
      or (selected.organization_id=$1 and ($2::uuid is null or selected.location_id=$2))
      or (recommended.organization_id=$1 and ($2::uuid is null or recommended.location_id=$2))
      or exists(
        select 1 from matches_offers mo
        join actors provider on provider.id=mo.actor_id
        where mo.case_id=sc.id
          and mo.outcome='accepted'
          and provider.organization_id=$1
          and ($2::uuid is null or provider.location_id=$2)
      )
    )
  )
  or exists(
    select 1 from actors recipient
    where recipient.id::text=n.recipient_id
      and recipient.organization_id=$1
      and ($2::uuid is null or recipient.location_id=$2)
  )
)`;

export async function notificationRoutes(app:FastifyInstance) {
  app.post('/api/admin/notifications/process', { preHandler:requireRole('admin') }, async (req,reply) => {
    const scope=await getAdminActorScope(req.principal,pool);
    if(scope)return reply.code(403).send({error:'notification_global_admin_required'});
    const body = z.object({ workerId:z.string().min(1).default('admin-manual'), limit:z.number().int().positive().max(200).default(50) }).parse(req.body ?? {});
    return { processed:await processNotificationBatch(req.principal,body.workerId,body.limit) };
  });

  app.get('/api/admin/notifications/outbox', { preHandler:requireRole('admin') }, async (req) => {
    const q = z.object({ state:z.string().optional(), limit:z.coerce.number().int().positive().max(500).default(100) }).parse(req.query ?? {});
    const scope=await getAdminActorScope(req.principal,pool);
    if(!scope){
      const r = q.state
        ? await pool.query('select * from notification_outbox where state=$1 order by created_at desc limit $2',[q.state,q.limit])
        : await pool.query('select * from notification_outbox order by created_at desc limit $1',[q.limit]);
      return { notifications:r.rows };
    }
    const r=q.state
      ? await pool.query(`select n.* from notification_outbox n where ${notificationScopePredicate} and n.state=$3 order by n.created_at desc limit $4`,[scope.organizationId,scope.locationId,q.state,q.limit])
      : await pool.query(`select n.* from notification_outbox n where ${notificationScopePredicate} order by n.created_at desc limit $3`,[scope.organizationId,scope.locationId,q.limit]);
    return {notifications:r.rows};
  });

  app.get('/api/admin/notifications/:id/attempts', { preHandler:requireRole('admin') }, async (req,reply) => {
    const { id } = z.object({ id:z.string().uuid() }).parse(req.params);
    const scope=await getAdminActorScope(req.principal,pool);
    const n=scope
      ? await pool.query(`select n.id from notification_outbox n where n.id=$3 and ${notificationScopePredicate}`,[scope.organizationId,scope.locationId,id])
      : await pool.query('select id from notification_outbox where id=$1',[id]);
    if (!n.rowCount) return reply.code(404).send({ error:'notification_not_found' });
    const r = await pool.query('select * from notification_delivery_attempts where notification_id=$1 order by attempt_number asc',[id]);
    return { attempts:r.rows };
  });

  app.post('/api/admin/notifications/templates', { preHandler:requireRole('admin') }, async (req,reply) => {
    const scope=await getAdminActorScope(req.principal,pool);
    if(scope)return reply.code(403).send({error:'notification_global_admin_required'});
    const body = z.object({
      templateKey:z.string().min(1), channel:z.enum(['push','email','sms']), subjectTemplate:z.string().optional(),
      bodyTemplate:z.string().min(1), active:z.boolean().optional(), metadata:z.record(z.unknown()).optional()
    }).parse(req.body);
    return reply.code(201).send({ template:await upsertNotificationTemplate(req.principal,body) });
  });

  app.get('/api/admin/notifications/templates', { preHandler:requireRole('admin') }, async (req,reply) => {
    const scope=await getAdminActorScope(req.principal,pool);
    if(scope)return reply.code(403).send({error:'notification_global_admin_required'});
    const r = await pool.query('select * from notification_templates order by template_key,channel,version desc');
    return { templates:r.rows };
  });

  app.put('/api/admin/notifications/channels/:channel', { preHandler:requireRole('admin') }, async (req,reply) => {
    const scope=await getAdminActorScope(req.principal,pool);
    if(scope)return reply.code(403).send({error:'notification_global_admin_required'});
    const { channel } = z.object({ channel:z.enum(['push','email','sms']) }).parse(req.params);
    const body = z.object({ provider:z.string().min(1), enabled:z.boolean(), configuration:z.record(z.unknown()).optional() }).parse(req.body);
    return { channel:await setChannelConfig(req.principal,{ channel,...body }) };
  });

  app.get('/api/admin/notifications/channels', { preHandler:requireRole('admin') }, async (req,reply) => {
    const scope=await getAdminActorScope(req.principal,pool);
    if(scope)return reply.code(403).send({error:'notification_global_admin_required'});
    const r = await pool.query('select channel,provider,enabled,configuration,updated_at from notification_channel_configs order by channel');
    return { channels:r.rows };
  });
}
