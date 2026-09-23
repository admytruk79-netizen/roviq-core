import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../middleware/principal.js';
import { receiveConnectorEvent } from '../../services/durable-events.js';

const inbound=z.object({
  connectorKey:z.string().min(2).max(120),
  externalEventId:z.string().min(1).max(250),
  eventType:z.string().min(1).max(120),
  payload:z.record(z.unknown()).default({})
});

export async function connectorGatewayRoutes(app:FastifyInstance){
  // Internal/admin ingress foundation. Public connector-specific endpoints should authenticate
  // signatures/API credentials first, then call receiveConnectorEvent with normalized data.
  app.post('/api/core/connectors/events',{preHandler:requireRole('admin')},async(req,reply)=>{
    const body=inbound.parse(req.body);
    const result=await receiveConnectorEvent(body);
    return reply.code(result.duplicate?200:202).send({accepted:true,duplicate:result.duplicate,eventId:result.event.id});
  });
}
