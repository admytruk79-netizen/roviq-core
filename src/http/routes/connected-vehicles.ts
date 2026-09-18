import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { audit } from '../../services/audit.js';
import { appendCaseEvent } from '../../services/case-events.js';
import { loadCaseForPrincipal } from '../../services/case-access.js';
import { requireRole } from '../middleware/principal.js';

async function loadOwnedVehicle(principal:any, vehicleId:string) {
  const result = await pool.query(
    `select id,customer_actor_id,vin,year,make,model,trim from customer_vehicles where id=$1`,
    [vehicleId]
  );
  if (!result.rowCount) {
    const error = new Error('vehicle_not_found') as Error & { statusCode:number };
    error.statusCode = 404;
    throw error;
  }
  const vehicle = result.rows[0];
  if (principal.role !== 'admin' && vehicle.customer_actor_id !== principal.actorId) {
    const error = new Error('forbidden') as Error & { statusCode:number };
    error.statusCode = 403;
    throw error;
  }
  return vehicle;
}

function healthEventDedupKey(input:{
  sourceId:string; vehicleId:string; sourceEventId?:string;
  eventType:string; occurredAt:string; dtcCodes:string[];
  normalizedSignals:Record<string,unknown>;
}) {
  if (input.sourceEventId) return `source:${input.sourceEventId}`;
  return createHash('sha256').update(JSON.stringify({
    sourceId:input.sourceId,
    vehicleId:input.vehicleId,
    eventType:input.eventType,
    occurredAt:input.occurredAt,
    dtcCodes:[...input.dtcCodes].sort(),
    normalizedSignals:input.normalizedSignals
  })).digest('hex');
}

export async function connectedVehicleRoutes(app:FastifyInstance) {
  app.post('/api/admin/connected/sources',{preHandler:requireRole('admin')},async(req,reply)=>{
    const body=z.object({
      sourceType:z.enum(['roviq_reader','oem_telematics','vehicle_api','customer_reported','technician','integration']),
      providerKey:z.string().min(1).max(120),
      organizationId:z.string().uuid().nullable().optional(),
      capabilityProfile:z.record(z.unknown()).optional(),
      metadata:z.record(z.unknown()).optional()
    }).parse(req.body);
    const result=await pool.query(
      `insert into connected_sources(source_type,provider_key,organization_id,capability_profile,metadata)
       values($1,$2,$3,$4,$5) returning *`,
      [
        body.sourceType,body.providerKey,body.organizationId??null,
        JSON.stringify(body.capabilityProfile??{}),JSON.stringify(body.metadata??{})
      ]
    );
    await audit(req.principal,'create_connected_source','connected_source',result.rows[0].id,'connected_vehicle_source_created',{
      sourceType:body.sourceType,providerKey:body.providerKey
    });
    return reply.code(201).send({source:result.rows[0]});
  });

  app.get('/api/admin/connected/sources',{preHandler:requireRole('admin')},async()=>{
    const result=await pool.query(
      `select id,source_type,provider_key,organization_id,status,capability_profile,metadata,created_at,updated_at
       from connected_sources order by created_at desc limit 500`
    );
    return {sources:result.rows};
  });

  app.post('/api/connected/enrollments',{preHandler:requireRole('customer','admin')},async(req,reply)=>{
    const body=z.object({
      vehicleId:z.string().uuid(),
      sourceId:z.string().uuid(),
      externalDeviceId:z.string().min(1).max(250).optional(),
      consentVersion:z.string().min(1).max(80),
      scopes:z.array(z.string().min(1).max(120)).min(1).default(['vehicle_health']),
      retentionDays:z.number().int().positive().max(3650).optional(),
      metadata:z.record(z.unknown()).optional()
    }).parse(req.body);
    const vehicle=await loadOwnedVehicle(req.principal,body.vehicleId);
    const source=await pool.query(
      `select id,status,source_type from connected_sources where id=$1`,
      [body.sourceId]
    );
    if(!source.rowCount) return reply.code(404).send({error:'connected_source_not_found'});
    if(source.rows[0].status!=='active') return reply.code(409).send({error:'connected_source_not_active'});

    const customerActorId=vehicle.customer_actor_id;
    if(!customerActorId) return reply.code(409).send({error:'vehicle_customer_required'});

    const client=await pool.connect();
    try{
      await client.query('begin');
      const consent=await client.query(
        `insert into connected_vehicle_consents(
          vehicle_id,customer_actor_id,consent_version,scopes,retention_until,metadata
        ) values($1,$2,$3,$4,
          case when $5::int is null then null else now()+make_interval(days=>$5::int) end,
          $6
        ) returning *`,
        [body.vehicleId,customerActorId,body.consentVersion,JSON.stringify(body.scopes),body.retentionDays??null,JSON.stringify(body.metadata??{})]
      );
      const enrollment=await client.query(
        `insert into device_enrollments(vehicle_id,source_id,consent_id,external_device_id,metadata)
         values($1,$2,$3,$4,$5)
         on conflict(source_id,external_device_id) where external_device_id is not null
         do update set vehicle_id=excluded.vehicle_id,consent_id=excluded.consent_id,enrollment_status='active',updated_at=now(),metadata=excluded.metadata
         returning *`,
        [body.vehicleId,body.sourceId,consent.rows[0].id,body.externalDeviceId??null,JSON.stringify(body.metadata??{})]
      );
      await client.query('commit');
      await audit(req.principal,'enroll_connected_vehicle','device_enrollment',enrollment.rows[0].id,'connected_vehicle_enrolled',{
        vehicleId:body.vehicleId,sourceId:body.sourceId
      });
      return reply.code(201).send({enrollment:enrollment.rows[0],consent:consent.rows[0]});
    }catch(error){
      await client.query('rollback').catch(()=>{});
      throw error;
    }finally{client.release();}
  });

  app.get('/api/connected/enrollments',{preHandler:requireRole('customer','admin')},async(req)=>{
    const actorId=req.principal.role==='customer'?req.principal.actorId??null:null;
    const result=await pool.query(
      `select de.*,cs.source_type,cs.provider_key,cvc.status as consent_status,cvc.retention_until
       from device_enrollments de
       join connected_sources cs on cs.id=de.source_id
       join connected_vehicle_consents cvc on cvc.id=de.consent_id
       join customer_vehicles cv on cv.id=de.vehicle_id
       where ($1::uuid is null or cv.customer_actor_id=$1::uuid)
       order by de.created_at desc limit 500`,
      [actorId]
    );
    return {enrollments:result.rows};
  });

  app.post('/api/connected/health-events',{preHandler:requireRole('customer','admin')},async(req,reply)=>{
    const body=z.object({
      vehicleId:z.string().uuid(),
      sourceId:z.string().uuid(),
      enrollmentId:z.string().uuid().optional(),
      serviceCaseId:z.string().uuid().optional(),
      sourceEventId:z.string().max(250).optional(),
      eventType:z.string().min(1).max(120),
      severity:z.enum(['info','advisory','warning','critical']).default('advisory'),
      safetyState:z.enum(['unknown','review_required','restricted_use','stop_driving']).default('review_required'),
      occurredAt:z.string().datetime(),
      dtcCodes:z.array(z.string().min(1).max(32)).max(100).default([]),
      normalizedSignals:z.record(z.unknown()).default({}),
      rawReference:z.record(z.unknown()).default({}),
      metadata:z.record(z.unknown()).default({})
    }).parse(req.body);

    await loadOwnedVehicle(req.principal,body.vehicleId);
    const source=await pool.query(`select * from connected_sources where id=$1`,[body.sourceId]);
    if(!source.rowCount) return reply.code(404).send({error:'connected_source_not_found'});
    if(source.rows[0].status!=='active') return reply.code(409).send({error:'connected_source_not_active'});

    if(body.enrollmentId){
      const enrollment=await pool.query(
        `select de.*,cvc.status as consent_status,cvc.retention_until
         from device_enrollments de
         join connected_vehicle_consents cvc on cvc.id=de.consent_id
         where de.id=$1 and de.vehicle_id=$2 and de.source_id=$3`,
        [body.enrollmentId,body.vehicleId,body.sourceId]
      );
      if(!enrollment.rowCount) return reply.code(409).send({error:'enrollment_mismatch'});
      const row=enrollment.rows[0];
      if(row.enrollment_status!=='active') return reply.code(409).send({error:'enrollment_not_active'});
      if(row.consent_status!=='active') return reply.code(409).send({error:'connected_consent_not_active'});
      if(row.retention_until&&new Date(row.retention_until).getTime()<=Date.now()) return reply.code(409).send({error:'connected_consent_expired'});
    }else if(['roviq_reader','oem_telematics','vehicle_api','integration'].includes(source.rows[0].source_type)){
      return reply.code(400).send({error:'enrollment_required'});
    }

    if(body.serviceCaseId){
      const serviceCase=await loadCaseForPrincipal(req.principal,body.serviceCaseId);
      if(serviceCase.vehicle_id&&serviceCase.vehicle_id!==body.vehicleId) return reply.code(409).send({error:'case_vehicle_mismatch'});
      if(!serviceCase.vehicle_id){
        await pool.query(`update service_cases set vehicle_id=$2,updated_at=now() where id=$1 and vehicle_id is null`,[body.serviceCaseId,body.vehicleId]);
      }
    }

    const deduplicationKey=healthEventDedupKey({
      sourceId:body.sourceId,vehicleId:body.vehicleId,sourceEventId:body.sourceEventId,
      eventType:body.eventType,occurredAt:body.occurredAt,dtcCodes:body.dtcCodes,normalizedSignals:body.normalizedSignals
    });
    const inserted=await pool.query(
      `insert into vehicle_health_events(
        vehicle_id,source_id,enrollment_id,service_case_id,source_event_id,event_type,severity,safety_state,
        occurred_at,dtc_codes,normalized_signals,raw_reference,deduplication_key,triage_state,metadata
       ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       on conflict(source_id,deduplication_key) do nothing
       returning *`,
      [
        body.vehicleId,body.sourceId,body.enrollmentId??null,body.serviceCaseId??null,body.sourceEventId??null,
        body.eventType,body.severity,body.safetyState,body.occurredAt,body.dtcCodes,
        JSON.stringify(body.normalizedSignals),JSON.stringify(body.rawReference),deduplicationKey,
        body.serviceCaseId?'linked_to_case':'unreviewed',JSON.stringify(body.metadata)
      ]
    );
    const event=inserted.rows[0]??(
      await pool.query(`select * from vehicle_health_events where source_id=$1 and deduplication_key=$2`,[body.sourceId,deduplicationKey])
    ).rows[0];

    if(inserted.rowCount&&body.enrollmentId){
      await pool.query(`update device_enrollments set last_seen_at=now(),updated_at=now() where id=$1`,[body.enrollmentId]);
    }
    if(inserted.rowCount&&body.serviceCaseId){
      await appendCaseEvent(body.serviceCaseId,'VEHICLE_HEALTH_EVENT_LINKED',req.principal,{
        vehicleHealthEventId:event.id,eventType:body.eventType,severity:body.severity,safetyState:body.safetyState
      });
    }
    if(inserted.rowCount){
      await audit(req.principal,'ingest_vehicle_health_event','vehicle_health_event',event.id,'connected_vehicle_event_ingested',{
        vehicleId:body.vehicleId,sourceId:body.sourceId,severity:body.severity,linkedCaseId:body.serviceCaseId??null
      });
    }
    return reply.code(inserted.rowCount?201:200).send({event,deduplicated:!inserted.rowCount});
  });

  app.get('/api/connected/vehicles/:vehicleId/health-events',{preHandler:requireRole('customer','admin')},async(req)=>{
    const {vehicleId}=z.object({vehicleId:z.string().uuid()}).parse(req.params);
    await loadOwnedVehicle(req.principal,vehicleId);
    const result=await pool.query(
      `select id,vehicle_id,source_id,enrollment_id,service_case_id,source_event_id,event_type,severity,safety_state,
              occurred_at,received_at,dtc_codes,normalized_signals,triage_state,metadata
       from vehicle_health_events where vehicle_id=$1 order by occurred_at desc limit 250`,
      [vehicleId]
    );
    return {events:result.rows};
  });

  app.post('/api/connected/vehicles/:vehicleId/warranty-coverages',{preHandler:requireRole('customer','admin')},async(req,reply)=>{
    const {vehicleId}=z.object({vehicleId:z.string().uuid()}).parse(req.params);
    await loadOwnedVehicle(req.principal,vehicleId);
    const body=z.object({
      coverageType:z.enum(['factory','extended','service_contract','none','unknown']),
      coverageStatus:z.enum(['unknown','active','expired','not_covered']).default('unknown'),
      providerName:z.string().max(200).nullable().optional(),
      contractReference:z.string().max(200).nullable().optional(),
      startsAt:z.string().date().nullable().optional(),
      endsAt:z.string().date().nullable().optional(),
      mileageLimit:z.number().int().positive().nullable().optional(),
      coveredComponents:z.array(z.string()).default([]),
      authorizedNetwork:z.record(z.unknown()).default({}),
      source:z.enum(['customer','dealer','oem','warranty_admin','admin','integration']).optional(),
      verifiedAt:z.string().datetime().nullable().optional(),
      metadata:z.record(z.unknown()).default({})
    }).parse(req.body);
    const source=req.principal.role==='customer'?'customer':(body.source??'admin');
    const result=await pool.query(
      `insert into warranty_coverages(
        vehicle_id,coverage_type,coverage_status,provider_name,contract_reference,starts_at,ends_at,mileage_limit,
        covered_components,authorized_network,source,verified_at,metadata
       ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
      [
        vehicleId,body.coverageType,body.coverageStatus,body.providerName??null,body.contractReference??null,
        body.startsAt??null,body.endsAt??null,body.mileageLimit??null,JSON.stringify(body.coveredComponents),
        JSON.stringify(body.authorizedNetwork),source,body.verifiedAt??null,JSON.stringify(body.metadata)
      ]
    );
    await audit(req.principal,'create_warranty_coverage','warranty_coverage',result.rows[0].id,'warranty_coverage_recorded',{
      vehicleId,coverageType:body.coverageType,coverageStatus:body.coverageStatus,source
    });
    return reply.code(201).send({coverage:result.rows[0]});
  });

  app.get('/api/connected/vehicles/:vehicleId/warranty-coverages',{preHandler:requireRole('customer','admin')},async(req)=>{
    const {vehicleId}=z.object({vehicleId:z.string().uuid()}).parse(req.params);
    await loadOwnedVehicle(req.principal,vehicleId);
    const result=await pool.query(
      `select * from warranty_coverages where vehicle_id=$1 order by created_at desc`,
      [vehicleId]
    );
    return {coverages:result.rows};
  });
}
