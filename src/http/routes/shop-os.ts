import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../middleware/principal.js';
import { createShopOsAppointment } from '../../services/shop-os-appointment-create.js';
import { updateShopOsAppointment } from '../../services/shop-os-appointment-update.js';
import { listShopOsSchedule } from '../../services/shop-os-schedule-query.js';
import { listShopOsBoard } from '../../services/shop-os-board.js';
import { createShopWaitlistEntry, listShopWaitlist, updateShopWaitlistEntry } from '../../services/shop-os-waitlist.js';
import { createShopResource, listShopResources, updateShopResource } from '../../services/shop-os-resources.js';
import {
  addRepairOrderLine, createRepairOrder, getRepairOrder, listRepairOrders, updateRepairOrder, updateRepairOrderLine
} from '../../services/shop-os-repair-orders.js';
import {
  createRepairOrderPartRequirement, deferRepairOrderLine, listDeferredService, listRepairOrderPartRequirements,
  reconcileRepairOrder, updateDeferredService, updateRepairOrderPartRequirement
} from '../../services/shop-os-completion.js';

const repairOrderStatusSchema=z.enum([
  'draft','estimate_pending','awaiting_approval','approved','in_progress','waiting_parts','waiting_customer',
  'quality_control','completed','closed','cancelled'
]);
const deferredStatusSchema=z.enum(['open','reminded','booked','completed','dismissed']);
const shopResourceTypeSchema=z.enum(['bay','technician','advisor','equipment','mobile_unit','tow_unit','valet_driver','loaner_vehicle']);

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
      internalNotes:z.string().max(5000).nullable().optional(),
      recoverySourceAppointmentId:z.string().uuid().optional()
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
      const changesSchedule=value.startsAt!==undefined||value.endsAt!==undefined||value.resourceId!==undefined;
      if(value.action!=='reschedule'&&changesSchedule){
        ctx.addIssue({code:z.ZodIssueCode.custom,message:'schedule fields are only allowed for reschedule',path:['action']});
      }
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

  app.post('/api/shop-os/waitlist',allowed,async(req,reply)=>{
    const body=z.object({
      organizationId:z.string().uuid().optional(),
      locationId:z.string().uuid().optional(),
      serviceCaseId:z.string().uuid().nullable().optional(),
      requestedServiceCategory:z.string().min(1).nullable().optional(),
      requestedAfter:z.string().datetime({offset:true}).nullable().optional(),
      requestedBefore:z.string().datetime({offset:true}).nullable().optional(),
      estimatedDurationMinutes:z.number().int().positive().nullable().optional(),
      preferredResourceTypes:z.array(shopResourceTypeSchema).max(20).optional(),
      priority:z.number().int().min(0).max(10000).optional(),
      notes:z.string().max(5000).nullable().optional()
    }).superRefine((value,ctx)=>{
      if(value.requestedAfter&&value.requestedBefore&&new Date(value.requestedBefore).getTime()<=new Date(value.requestedAfter).getTime()){
        ctx.addIssue({code:z.ZodIssueCode.custom,message:'requestedBefore must be after requestedAfter',path:['requestedBefore']});
      }
    }).parse(req.body);
    return reply.code(201).send({entry:await createShopWaitlistEntry(req.principal,body)});
  });

  app.get('/api/shop-os/waitlist',allowed,async(req)=>{
    const query=z.object({
      organizationId:z.string().uuid().optional(),
      locationId:z.string().uuid().optional(),
      states:z.string().optional()
    }).parse(req.query);
    const states=query.states
      ? query.states.split(',').map((state)=>state.trim()).filter(Boolean)
      : undefined;
    if(states){
      const allowedStates=new Set(['waiting','offered','booked','expired','cancelled']);
      if(states.some((state)=>!allowedStates.has(state))) throw Object.assign(new Error('waitlist_state_invalid'),{statusCode:400});
    }
    return await listShopWaitlist(req.principal,{organizationId:query.organizationId,locationId:query.locationId,states});
  });

  app.patch('/api/shop-os/waitlist/:entryId',allowed,async(req)=>{
    const params=z.object({entryId:z.string().uuid()}).parse(req.params);
    const body=z.object({
      action:z.enum(['offer','book','cancel','expire','requeue']),
      appointmentId:z.string().uuid().optional()
    }).parse(req.body);
    return {entry:await updateShopWaitlistEntry(req.principal,params.entryId,body)};
  });

  app.post('/api/shop-os/resources',allowed,async(req,reply)=>{
    const body=z.object({
      organizationId:z.string().uuid().optional(),locationId:z.string().uuid().optional(),
      resourceType:shopResourceTypeSchema,
      displayName:z.string().min(1).max(200),capabilityTags:z.array(z.string().min(1)).max(100).optional(),
      constraints:z.record(z.string(),z.unknown()).optional(),assignedActorId:z.string().uuid().nullable().optional(),
      operationalState:z.enum(['available','busy','blocked','offline']).optional(),
      hourlyCost:z.number().nonnegative().nullable().optional(),laborRate:z.number().nonnegative().nullable().optional()
    }).parse(req.body);
    return reply.code(201).send({resource:await createShopResource(req.principal,body)});
  });

  app.get('/api/shop-os/resources',allowed,async(req)=>{
    const query=z.object({
      organizationId:z.string().uuid().optional(),locationId:z.string().uuid().optional(),
      resourceType:shopResourceTypeSchema.optional(),
      includeInactive:z.enum(['true','false']).optional()
    }).parse(req.query);
    return await listShopResources(req.principal,{...query,includeInactive:query.includeInactive==='true'});
  });

  app.patch('/api/shop-os/resources/:resourceId',allowed,async(req)=>{
    const params=z.object({resourceId:z.string().uuid()}).parse(req.params);
    const body=z.object({
      displayName:z.string().min(1).max(200).optional(),capabilityTags:z.array(z.string().min(1)).max(100).optional(),
      constraints:z.record(z.string(),z.unknown()).optional(),assignedActorId:z.string().uuid().nullable().optional(),
      operationalState:z.enum(['available','busy','blocked','offline']).optional(),active:z.boolean().optional(),
      hourlyCost:z.number().nonnegative().nullable().optional(),laborRate:z.number().nonnegative().nullable().optional()
    }).parse(req.body);
    return {resource:await updateShopResource(req.principal,params.resourceId,body)};
  });

  app.post('/api/shop-os/repair-orders',allowed,async(req,reply)=>{
    const body=z.object({
      organizationId:z.string().uuid().optional(),locationId:z.string().uuid().optional(),serviceCaseId:z.string().uuid().nullable().optional(),
      appointmentId:z.string().uuid().nullable().optional(),customerVehicleId:z.string().uuid().nullable().optional(),
      advisorActorId:z.string().uuid().nullable().optional(),primaryTechnicianActorId:z.string().uuid().nullable().optional(),
      customerConcern:z.string().max(5000).nullable().optional(),internalNotes:z.string().max(10000).nullable().optional(),
      odometer:z.number().int().nonnegative().nullable().optional()
    }).parse(req.body);
    return reply.code(201).send({repairOrder:await createRepairOrder(req.principal,body)});
  });

  app.get('/api/shop-os/repair-orders',allowed,async(req)=>{
    const query=z.object({organizationId:z.string().uuid().optional(),locationId:z.string().uuid().optional(),statuses:z.string().optional()}).parse(req.query);
    const statuses=query.statuses
      ? z.array(repairOrderStatusSchema).parse(query.statuses.split(',').map((value)=>value.trim()).filter(Boolean))
      : undefined;
    return await listRepairOrders(req.principal,{organizationId:query.organizationId,locationId:query.locationId,statuses});
  });

  app.get('/api/shop-os/repair-orders/:repairOrderId',allowed,async(req)=>{
    const params=z.object({repairOrderId:z.string().uuid()}).parse(req.params);
    return await getRepairOrder(req.principal,params.repairOrderId);
  });

  app.post('/api/shop-os/repair-orders/:repairOrderId/lines',allowed,async(req,reply)=>{
    const params=z.object({repairOrderId:z.string().uuid()}).parse(req.params);
    const body=z.object({
      lineType:z.enum(['labor','part','fee','sublet']),description:z.string().min(1).max(5000),serviceCategory:z.string().max(200).nullable().optional(),
      quantity:z.number().positive().optional(),unitPrice:z.number().nonnegative().optional(),unitCost:z.number().nonnegative().optional(),
      laborHours:z.number().nonnegative().nullable().optional(),taxable:z.boolean().optional(),sortOrder:z.number().int().optional(),
      metadata:z.record(z.string(),z.unknown()).optional()
    }).parse(req.body);
    return reply.code(201).send(await addRepairOrderLine(req.principal,params.repairOrderId,body));
  });

  app.patch('/api/shop-os/repair-orders/:repairOrderId/lines/:lineId',allowed,async(req)=>{
    const params=z.object({repairOrderId:z.string().uuid(),lineId:z.string().uuid()}).parse(req.params);
    const body=z.object({
      approvalStatus:z.enum(['pending','approved','declined','deferred']).optional(),description:z.string().min(1).max(5000).optional(),
      quantity:z.number().positive().optional(),unitPrice:z.number().nonnegative().optional(),unitCost:z.number().nonnegative().optional()
    }).parse(req.body);
    return await updateRepairOrderLine(req.principal,params.repairOrderId,params.lineId,body);
  });

  app.patch('/api/shop-os/repair-orders/:repairOrderId',allowed,async(req)=>{
    const params=z.object({repairOrderId:z.string().uuid()}).parse(req.params);
    const body=z.object({
      action:z.enum(['submit_estimate','revise_estimate','approve','start','wait_parts','wait_customer','resume','qc','complete','close','cancel']),
      advisorActorId:z.string().uuid().nullable().optional(),primaryTechnicianActorId:z.string().uuid().nullable().optional(),
      internalNotes:z.string().max(10000).nullable().optional()
    }).parse(req.body);
    return {repairOrder:await updateRepairOrder(req.principal,params.repairOrderId,body)};
  });

  app.post('/api/shop-os/repair-orders/:repairOrderId/parts-requirements',allowed,async(req,reply)=>{
    const params=z.object({repairOrderId:z.string().uuid()}).parse(req.params);
    const body=z.object({
      repairOrderLineId:z.string().uuid(),description:z.string().max(5000).nullable().optional(),partReference:z.string().max(500).nullable().optional(),
      quantity:z.number().positive().optional(),supplierReference:z.string().max(500).nullable().optional(),partsOrderId:z.string().uuid().nullable().optional(),
      eta:z.string().datetime({offset:true}).nullable().optional()
    }).parse(req.body);
    return reply.code(201).send({requirement:await createRepairOrderPartRequirement(req.principal,{repairOrderId:params.repairOrderId,...body})});
  });

  app.get('/api/shop-os/repair-orders/:repairOrderId/parts-requirements',allowed,async(req)=>{
    const params=z.object({repairOrderId:z.string().uuid()}).parse(req.params);
    return await listRepairOrderPartRequirements(req.principal,params.repairOrderId);
  });

  app.patch('/api/shop-os/parts-requirements/:requirementId',allowed,async(req)=>{
    const params=z.object({requirementId:z.string().uuid()}).parse(req.params);
    const body=z.object({
      readinessStatus:z.enum(['identified','sourcing','ordered','eta_known','received','ready','unavailable','cancelled']),
      eta:z.string().datetime({offset:true}).nullable().optional(),supplierReference:z.string().max(500).nullable().optional(),
      partsOrderId:z.string().uuid().nullable().optional()
    }).parse(req.body);
    return {requirement:await updateRepairOrderPartRequirement(req.principal,params.requirementId,body)};
  });

  app.post('/api/shop-os/repair-orders/:repairOrderId/lines/:lineId/defer',allowed,async(req,reply)=>{
    const params=z.object({repairOrderId:z.string().uuid(),lineId:z.string().uuid()}).parse(req.params);
    const body=z.object({
      severity:z.enum(['recommended','attention','urgent']).optional(),reason:z.string().max(5000).nullable().optional(),
      targetReturnAt:z.string().datetime({offset:true}).nullable().optional(),nextFollowUpAt:z.string().datetime({offset:true}).nullable().optional()
    }).parse(req.body??{});
    return reply.code(201).send({deferredItem:await deferRepairOrderLine(req.principal,{repairOrderId:params.repairOrderId,repairOrderLineId:params.lineId,...body})});
  });

  app.get('/api/shop-os/deferred-service',allowed,async(req)=>{
    const query=z.object({organizationId:z.string().uuid().optional(),locationId:z.string().uuid().optional(),statuses:z.string().optional()}).parse(req.query);
    const statuses=query.statuses
      ? z.array(deferredStatusSchema).parse(query.statuses.split(',').map((value)=>value.trim()).filter(Boolean))
      : undefined;
    return await listDeferredService(req.principal,{organizationId:query.organizationId,locationId:query.locationId,statuses});
  });

  app.patch('/api/shop-os/deferred-service/:deferredItemId',allowed,async(req)=>{
    const params=z.object({deferredItemId:z.string().uuid()}).parse(req.params);
    const body=z.object({
      action:z.enum(['remind','book','complete','dismiss','reopen']),appointmentId:z.string().uuid().nullable().optional(),
      nextFollowUpAt:z.string().datetime({offset:true}).nullable().optional()
    }).parse(req.body);
    return {deferredItem:await updateDeferredService(req.principal,params.deferredItemId,body)};
  });

  app.post('/api/shop-os/repair-orders/:repairOrderId/reconcile',allowed,async(req)=>{
    const params=z.object({repairOrderId:z.string().uuid()}).parse(req.params);
    return await reconcileRepairOrder(req.principal,params.repairOrderId);
  });
}
