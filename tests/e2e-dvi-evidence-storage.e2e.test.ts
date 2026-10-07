import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { createDviInspection } from '../src/services/shop-os-floor.js';
import { createShopResource } from '../src/services/shop-os-resources.js';
import { addRepairOrderLine, createRepairOrder, updateRepairOrder, updateRepairOrderLine } from '../src/services/shop-os-repair-orders.js';

const admin={role:'admin'} as const;
const EDGE_SECRET='test-edge-secret';

// Stands in for the Cloudflare Worker's /internal/storage/ handler (which is backed by a real R2
// bucket in production) so this test proves Core's upload/download routes -- auth, access
// control, byte-for-byte round trip -- work without needing live Cloudflare access.
function startFakeEdgeStorage(){
  const objects=new Map<string,{buffer:Buffer;contentType:string}>();
  const server=createServer((req,res)=>{
    if(req.headers['x-edge-storage-key']!==EDGE_SECRET){res.writeHead(401);res.end();return;}
    const key=decodeURIComponent((req.url??'').replace(/^\/internal\/storage\//,''));
    if(req.method==='PUT'){
      const chunks:Buffer[]=[];
      req.on('data',(c)=>chunks.push(c));
      req.on('end',()=>{
        objects.set(key,{buffer:Buffer.concat(chunks),contentType:String(req.headers['content-type']??'application/octet-stream')});
        res.writeHead(200,{'content-type':'application/json'});
        res.end(JSON.stringify({ok:true,key}));
      });
      return;
    }
    if(req.method==='GET'){
      const object=objects.get(key);
      if(!object){res.writeHead(404);res.end();return;}
      res.writeHead(200,{'content-type':object.contentType});
      res.end(object.buffer);
      return;
    }
    res.writeHead(405);res.end();
  });
  return new Promise<{close:()=>Promise<void>}>((resolve)=>{
    server.listen(0,'127.0.0.1',()=>{
      const {port}=server.address() as AddressInfo;
      process.env.EDGE_STORAGE_URL=`http://127.0.0.1:${port}`;
      process.env.EDGE_STORAGE_KEY=EDGE_SECRET;
      resolve({close:()=>new Promise((r)=>server.close(()=>r()))});
    });
  });
}

async function setupShop(){
  const org=await pool.query(`insert into organizations(organization_type,display_name) values('shop',$1) returning id`,[
    `DVI Storage Shop ${Date.now()}-${Math.random()}`
  ]);
  await pool.query(`insert into partner_system_connections(
    organization_id,mode,provider_key,display_name,connection_status
  ) values($1,'roviq_native','roviq','Shop OS Native','active')`,[org.rows[0].id]);
  const actor=await pool.query(`insert into actors(actor_type,status,organization_id) values('shop','active',$1) returning id`,[org.rows[0].id]);
  const technician=await pool.query(`insert into actors(actor_type,status,organization_id) values('technician','active',$1) returning id`,[org.rows[0].id]);
  return {orgId:org.rows[0].id as string,actorId:actor.rows[0].id as string,technicianActorId:technician.rows[0].id as string};
}

async function setupActiveRepairOrder(){
  const shop=await setupShop();
  const order=await createRepairOrder(admin,{organizationId:shop.orgId,primaryTechnicianActorId:shop.technicianActorId,customerConcern:'Brake vibration'});
  const labor=await addRepairOrderLine(admin,order.id,{lineType:'labor',description:'Front brake service',quantity:1,unitPrice:300,unitCost:120,laborHours:2});
  await updateRepairOrder(admin,order.id,{action:'submit_estimate'});
  await updateRepairOrderLine(admin,order.id,labor.line.id,{approvalStatus:'approved'});
  await updateRepairOrder(admin,order.id,{action:'approve'});
  await updateRepairOrder(admin,order.id,{action:'start'});
  await createShopResource(admin,{organizationId:shop.orgId,resourceType:'technician',displayName:'Tech A',assignedActorId:shop.technicianActorId,capabilityTags:['brakes']});
  return {...shop,repairOrderId:order.id as string};
}

describe('DVI evidence storage',()=>{
  let app:FastifyInstance;
  let fakeStorage:{close:()=>Promise<void>};

  beforeAll(async()=>{
    fakeStorage=await startFakeEdgeStorage();
    app=await buildApp();
  });
  afterAll(async()=>{
    await fakeStorage.close();
    await pool.end();
  });

  it('uploads a photo, stores it through the edge storage service, and streams the exact bytes back on download',async()=>{
    const shop=await setupActiveRepairOrder();
    const inspection=await createDviInspection(admin,{repairOrderId:shop.repairOrderId,technicianActorId:shop.technicianActorId});
    const photoBytes=Buffer.from('fake-jpeg-bytes-not-a-real-image');

    const uploadRes=await app.inject({
      method:'POST',
      url:`/api/shop-os/dvi/${inspection.id}/evidence/upload?mediaType=photo&customerVisible=true`,
      headers:{'x-roviq-role':'admin','x-admin-api-key':process.env.ADMIN_API_KEY!,'content-type':'image/jpeg'},
      payload:photoBytes
    });
    expect(uploadRes.statusCode).toBe(201);
    const evidence=JSON.parse(uploadRes.body).evidence;
    expect(evidence.storage_key).toMatch(new RegExp(`^dvi/${inspection.id}/photo/.+\\.jpeg$`));
    expect(evidence.mime_type).toBe('image/jpeg');

    const downloadRes=await app.inject({
      method:'GET',
      url:`/api/shop-os/dvi/evidence/${evidence.id}/file`,
      headers:{'x-roviq-role':'admin','x-admin-api-key':process.env.ADMIN_API_KEY!}
    });
    expect(downloadRes.statusCode).toBe(200);
    expect(downloadRes.headers['content-type']).toBe('image/jpeg');
    expect(Buffer.from(downloadRes.rawPayload)).toEqual(photoBytes);
  });

  it('rejects a content type that does not match the declared media type',async()=>{
    const shop=await setupActiveRepairOrder();
    const inspection=await createDviInspection(admin,{repairOrderId:shop.repairOrderId,technicianActorId:shop.technicianActorId});
    const res=await app.inject({
      method:'POST',
      url:`/api/shop-os/dvi/${inspection.id}/evidence/upload?mediaType=photo`,
      headers:{'x-roviq-role':'admin','x-admin-api-key':process.env.ADMIN_API_KEY!,'content-type':'application/pdf'},
      payload:Buffer.from('%PDF-fake')
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('dvi_evidence_content_type_invalid');
  });

  it('keeps evidence downloads tenant isolated',async()=>{
    const shopA=await setupActiveRepairOrder();
    const shopB=await setupActiveRepairOrder();
    const inspectionB=await createDviInspection(admin,{repairOrderId:shopB.repairOrderId,technicianActorId:shopB.technicianActorId});
    const uploadRes=await app.inject({
      method:'POST',
      url:`/api/shop-os/dvi/${inspectionB.id}/evidence/upload?mediaType=document`,
      headers:{'x-roviq-role':'admin','x-admin-api-key':process.env.ADMIN_API_KEY!,'content-type':'application/pdf'},
      payload:Buffer.from('%PDF-fake-doc')
    });
    const evidenceId=JSON.parse(uploadRes.body).evidence.id;

    const res=await app.inject({
      method:'GET',
      url:`/api/shop-os/dvi/evidence/${evidenceId}/file`,
      headers:{'x-roviq-role':'partner','x-roviq-actor-id':shopA.actorId}
    });
    expect(res.statusCode).toBe(403);
  });
});
