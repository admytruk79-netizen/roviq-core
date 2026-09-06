import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../middleware/principal.js';
import { createShopOsAppointment, listShopOsSchedule, updateShopOsAppointment } from '../../services/shop-os.js';
import { listShopOsBoard } from '../../services/shop-os-board.js';

export async function shopOsRoutes(app:FastifyInstance){
  const allowed={preHandler:requireRole('admin','partner')};

  app.post('/api/shop-os/appointments',allowed,async(req,reply)=>{
    const body=z.object({
      serviceCaseId:z.string().uuid().nullable().optional(),
      resourceId:z.string().uuid(),
      startsAt:z.string().datetime({offset:true}),
      endsAt:z.string().datetime({offset:true}),
      serviceCategory:z.string().min(1).nullable().optional(),
      status:z.enum(['held','confirmed']).optional(),
      customerVisibleSummary:z.string().max(1000).nullable().optional(),
      internalNotes:z.string().max(5000).nullable().optional()
    }).refine((value)=>new Date(value.endsAt).getTime()>new Date(value.startsAt).getTime(),{message:'endsAt must be after startsAt',path:['endsAt']}).parse(req.body);
    const appointment=await createShopOsAppointment(req.principal,body);
    return reply.code(201).send({appointment});
  });

  app.patch('/api/shop-os/appointments/:appointmentId',allowed,async(req)=>{
    const params=z.object({appointmentId:z.string().uuid()}).parse(req.params);
    const body=z.object({
      action:z.enum(['confirm','start','complete','cancel','release','no_show','reschedule']),
      startsAt:z.string().datetime({offset:true}).optional(),
      endsAt:z.string().datetime({offset:true}).optional(),
      resourceId:z.string().uuid().optional(),
      reason:z.string().max(1000).nullable().optional()
    }).superRefine((value,ctx)=>{
      if(value.startsAt&&value.endsAt&&new Date(value.endsAt).getTime()<=new Date(value.startsAt).getTime()){
        ctx.addIssue({code:z.ZodIssueCode.custom,message:'endsAt must be after startsAt',path:['endsAt']});
      }
    }).parse(req.body);
    return {appointment:await updateShopOsAppointment(req.principal,params.appointmentId,body)};
  });

  app.get('/api/shop-os/schedule',allowed,async(req)=>{
    const query=z.object({
      resourceId:z.string().uuid(),
      from:z.string().datetime({offset:true}),
      to:z.string().datetime({offset:true})
    }).refine((value)=>new Date(value.to).getTime()>new Date(value.from).getTime(),{message:'to must be after from',path:['to']}).parse(req.query);
    return await listShopOsSchedule(req.principal,query);
  });

  app.get('/api/shop-os/board',allowed,async(req)=>{
    const query=z.object({
      organizationId:z.string().uuid().optional(),
      locationId:z.string().uuid().optional(),
      from:z.string().datetime({offset:true}),
      to:z.string().datetime({offset:true})
    }).refine((value)=>new Date(value.to).getTime()>new Date(value.from).getTime(),{message:'to must be after from',path:['to']}).parse(req.query);
    return await listShopOsBoard(req.principal,query);
  });
}
