import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../middleware/principal.js';
import { listDeferredAppointmentChoices } from '../../services/shop-os-deferred-appointment-choices.js';

export async function shopOsDeferredAppointmentChoiceRoutes(app:FastifyInstance){
  const allowed={preHandler:requireRole('admin','partner')};

  app.get('/api/shop-os/deferred-service/appointment-choices',allowed,async(req)=>{
    const query=z.object({
      organizationId:z.string().uuid().optional(),
      locationId:z.string().uuid().optional()
    }).parse(req.query);
    return await listDeferredAppointmentChoices(req.principal,query);
  });
}
