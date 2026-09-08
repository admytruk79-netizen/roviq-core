import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../middleware/principal.js';
import {
  addDviEvidence, addDviFinding, clockTechnicianIn, clockTechnicianOut, createDviInspection,
  createWorkItem, getShopFloor, submitDviInspection, updateWorkItem
} from '../../services/shop-os-floor.js';

export async function shopOsFloorRoutes(app:FastifyInstance){
  const allowed={preHandler:requireRole('admin','partner')};

  app.get('/api/shop-os/repair-orders/:repairOrderId/floor',allowed,async(req)=>{
    const params=z.object({repairOrderId:z.string().uuid()}).parse(req.params);
    return await getShopFloor(req.principal,params.repairOrderId);
  });

  app.post('/api/shop-os/repair-orders/:repairOrderId/dvi',allowed,async(req,reply)=>{
    const params=z.object({repairOrderId:z.string().uuid()}).parse(req.params);
    const body=z.object({
      technicianActorId:z.string().uuid().nullable().optional(),
      inspectionType:z.string().min(1).max(200).optional(),
      summary:z.string().max(5000).nullable().optional()
    }).parse(req.body);
    return reply.code(201).send({inspection:await createDviInspection(req.principal,{repairOrderId:params.repairOrderId,...body})});
  });

  app.post('/api/shop-os/dvi/:inspectionId/findings',allowed,async(req,reply)=>{
    const params=z.object({inspectionId:z.string().uuid()}).parse(req.params);
    const body=z.object({
      section:z.string().min(1).max(200),item:z.string().min(1).max(500),
      severity:z.enum(['good','attention','urgent','not_inspected']),
      repairOrderLineId:z.string().uuid().nullable().optional(),measurement:z.string().max(200).nullable().optional(),
      technicianNote:z.string().max(5000).nullable().optional(),customerNote:z.string().max(5000).nullable().optional(),
      sortOrder:z.number().int().optional()
    }).parse(req.body);
    return reply.code(201).send({finding:await addDviFinding(req.principal,params.inspectionId,body)});
  });

  app.post('/api/shop-os/dvi/:inspectionId/evidence',allowed,async(req,reply)=>{
    const params=z.object({inspectionId:z.string().uuid()}).parse(req.params);
    const body=z.object({
      findingId:z.string().uuid().nullable().optional(),mediaType:z.enum(['photo','video','document']),
      storageKey:z.string().min(1).max(2000),mimeType:z.string().max(200).nullable().optional(),
      caption:z.string().max(2000).nullable().optional(),customerVisible:z.boolean().optional()
    }).parse(req.body);
    return reply.code(201).send({evidence:await addDviEvidence(req.principal,params.inspectionId,body)});
  });

  app.patch('/api/shop-os/dvi/:inspectionId/submit',allowed,async(req)=>{
    const params=z.object({inspectionId:z.string().uuid()}).parse(req.params);
    return {inspection:await submitDviInspection(req.principal,params.inspectionId)};
  });

  app.post('/api/shop-os/repair-orders/:repairOrderId/work-items',allowed,async(req,reply)=>{
    const params=z.object({repairOrderId:z.string().uuid()}).parse(req.params);
    const body=z.object({
      repairOrderLineId:z.string().uuid().nullable().optional(),title:z.string().min(1).max(500),description:z.string().max(5000).nullable().optional(),
      technicianActorId:z.string().uuid().nullable().optional(),technicianResourceId:z.string().uuid().nullable().optional(),
      bayResourceId:z.string().uuid().nullable().optional(),estimatedMinutes:z.number().int().nonnegative().nullable().optional()
    }).parse(req.body);
    return reply.code(201).send({workItem:await createWorkItem(req.principal,{repairOrderId:params.repairOrderId,...body})});
  });

  app.patch('/api/shop-os/work-items/:workItemId',allowed,async(req)=>{
    const params=z.object({workItemId:z.string().uuid()}).parse(req.params);
    const body=z.object({
      action:z.enum(['assign','start','pause','wait_parts','wait_customer','resume','qc','complete','cancel']),
      technicianActorId:z.string().uuid().nullable().optional(),technicianResourceId:z.string().uuid().nullable().optional(),
      bayResourceId:z.string().uuid().nullable().optional(),blockedReason:z.string().max(2000).nullable().optional()
    }).parse(req.body);
    return {workItem:await updateWorkItem(req.principal,params.workItemId,body)};
  });

  app.post('/api/shop-os/work-items/:workItemId/clock-in',allowed,async(req,reply)=>{
    const params=z.object({workItemId:z.string().uuid()}).parse(req.params);
    const body=z.object({
      technicianActorId:z.string().uuid().optional(),technicianResourceId:z.string().uuid().nullable().optional(),notes:z.string().max(2000).nullable().optional()
    }).parse(req.body);
    return reply.code(201).send({timeEntry:await clockTechnicianIn(req.principal,params.workItemId,body)});
  });

  app.post('/api/shop-os/work-items/:workItemId/clock-out',allowed,async(req)=>{
    const params=z.object({workItemId:z.string().uuid()}).parse(req.params);
    const body=z.object({endReason:z.enum(['pause','complete','switch','manual']).optional(),notes:z.string().max(2000).nullable().optional()}).parse(req.body);
    return {timeEntry:await clockTechnicianOut(req.principal,params.workItemId,body)};
  });
}
