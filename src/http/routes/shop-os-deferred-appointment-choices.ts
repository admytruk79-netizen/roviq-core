import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../middleware/principal.js';
import { listDeferredAppointmentChoices } from '../../services/shop-os-deferred-appointment-choices.js';

export async function shopOsDeferredAppointmentChoiceRoutes(app:FastifyInstance){
  const allowed={preHandler:requireRole('admin','partner')};

  app.get('/api/shop-os/deferred-service/appointment-choices',allowed,async(req)=>{
    const query=z.object({
      organizationId:z.string().uuid().optional(),
      locationId:z.string().uuid().optional(),
      afterStart:z.string().datetime({offset:true}).optional(),
      afterId:z.string().uuid().optional(),
      limit:z.coerce.number().int().positive().max(500).optional()
    }).superRefine((value,ctx)=>{
      if(Boolean(value.afterStart)!==Boolean(value.afterId)){
        ctx.addIssue({code:z.ZodIssueCode.custom,message:'afterStart and afterId must be supplied together'});
      }
    }).parse(req.query);
    return await listDeferredAppointmentChoices(req.principal,query);
  });
}
