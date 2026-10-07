import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../middleware/principal.js';
import {
  addDviEvidence, addDviFinding, assertEvidenceContentType, buildEvidenceStorageKey, clockTechnicianIn,
  clockTechnicianOut, createDviInspection, createWorkItem, getDviEvidenceForDownload, getShopFloor,
  submitDviInspection, updateWorkItem
} from '../../services/shop-os-floor.js';
import { getEdgeObject, putEdgeObject } from '../../services/edge-storage.js';

const MAX_EVIDENCE_BYTES=25*1024*1024;

export async function shopOsFloorRoutes(app:FastifyInstance){
  const allowed={preHandler:requireRole('admin','partner')};

  // Raw binary upload for one piece of DVI evidence -- the client PUTs the photo/video/PDF bytes
  // directly, Core checks shop-floor access first, then hands the bytes to the edge storage
  // service (Core itself holds no object-storage credentials; see services/edge-storage.ts).
  app.addContentTypeParser(
    ['image/jpeg','image/png','image/webp','image/heic','image/heif','video/mp4','video/quicktime','video/webm','application/pdf'],
    {parseAs:'buffer',bodyLimit:MAX_EVIDENCE_BYTES},
    (_req,body,done)=>done(null,body)
  );
  app.post('/api/shop-os/dvi/:inspectionId/evidence/upload',{...allowed,bodyLimit:MAX_EVIDENCE_BYTES},async(req,reply)=>{
    const params=z.object({inspectionId:z.string().uuid()}).parse(req.params);
    const query=z.object({
      mediaType:z.enum(['photo','video','document']),findingId:z.string().uuid().optional(),
      caption:z.string().max(2000).optional(),customerVisible:z.coerce.boolean().optional()
    }).parse(req.query);
    const contentType=req.headers['content-type'];
    assertEvidenceContentType(query.mediaType,contentType);
    const buffer=req.body as Buffer;
    if(!Buffer.isBuffer(buffer)||!buffer.length) return reply.code(400).send({error:'dvi_evidence_body_required'});
    const storageKey=buildEvidenceStorageKey(params.inspectionId,query.mediaType,contentType!);
    await putEdgeObject(storageKey,buffer,contentType);
    return reply.code(201).send({evidence:await addDviEvidence(req.principal,params.inspectionId,{
      findingId:query.findingId??null,mediaType:query.mediaType,storageKey,mimeType:contentType,
      caption:query.caption??null,customerVisible:query.customerVisible
    })});
  });

  // Streams the bytes back out. Access is re-checked here (not just at upload time) so the
  // storage key -- which lives behind a shared secret the client never sees -- is never the
  // access boundary; shop-floor scope is.
  app.get('/api/shop-os/dvi/evidence/:evidenceId/file',allowed,async(req,reply)=>{
    const params=z.object({evidenceId:z.string().uuid()}).parse(req.params);
    const evidence=await getDviEvidenceForDownload(req.principal,params.evidenceId);
    const {buffer,contentType}=await getEdgeObject(evidence.storage_key);
    reply.header('content-type',contentType??evidence.mime_type??'application/octet-stream');
    reply.header('cache-control','private, max-age=300');
    return reply.send(buffer);
  });

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
