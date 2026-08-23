import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { requireRole } from '../middleware/principal.js';
import { processNotificationBatch, setChannelConfig, upsertNotificationTemplate } from '../../services/notifications.js';

export async function notificationRoutes(app:FastifyInstance) {
  app.post('/api/admin/notifications/process', { preHandler:requireRole('admin') }, async (req) => {
    const body = z.object({ workerId:z.string().min(1).default('admin-manual'), limit:z.number().int().positive().max(200).default(50) }).parse(req.body ?? {});
    return { processed:await processNotificationBatch(req.principal,body.workerId,body.limit) };
  });

  app.get('/api/admin/notifications/outbox', { preHandler:requireRole('admin') }, async (req) => {
    const q = z.object({ state:z.string().optional(), limit:z.coerce.number().int().positive().max(500).default(100) }).parse(req.query ?? {});
    const r = q.state
      ? await pool.query('select * from notification_outbox where state=$1 order by created_at desc limit $2',[q.state,q.limit])
      : await pool.query('select * from notification_outbox order by created_at desc limit $1',[q.limit]);
    return { notifications:r.rows };
  });

  app.get('/api/admin/notifications/:id/attempts', { preHandler:requireRole('admin') }, async (req,reply) => {
    const { id } = z.object({ id:z.string().uuid() }).parse(req.params);
    const n = await pool.query('select id from notification_outbox where id=$1',[id]);
    if (!n.rowCount) return reply.code(404).send({ error:'notification_not_found' });
    const r = await pool.query('select * from notification_delivery_attempts where notification_id=$1 order by attempt_number asc',[id]);
    return { attempts:r.rows };
  });

  app.post('/api/admin/notifications/templates', { preHandler:requireRole('admin') }, async (req,reply) => {
    const body = z.object({
      templateKey:z.string().min(1), channel:z.enum(['push','email','sms']), subjectTemplate:z.string().optional(),
      bodyTemplate:z.string().min(1), active:z.boolean().optional(), metadata:z.record(z.unknown()).optional()
    }).parse(req.body);
    return reply.code(201).send({ template:await upsertNotificationTemplate(req.principal,body) });
  });

  app.get('/api/admin/notifications/templates', { preHandler:requireRole('admin') }, async () => {
    const r = await pool.query('select * from notification_templates order by template_key,channel,version desc');
    return { templates:r.rows };
  });

  app.put('/api/admin/notifications/channels/:channel', { preHandler:requireRole('admin') }, async (req) => {
    const { channel } = z.object({ channel:z.enum(['push','email','sms']) }).parse(req.params);
    const body = z.object({ provider:z.string().min(1), enabled:z.boolean(), configuration:z.record(z.unknown()).optional() }).parse(req.body);
    return { channel:await setChannelConfig(req.principal,{ channel,...body }) };
  });

  app.get('/api/admin/notifications/channels', { preHandler:requireRole('admin') }, async () => {
    const r = await pool.query('select channel,provider,enabled,configuration,updated_at from notification_channel_configs order by channel');
    return { channels:r.rows };
  });
}
