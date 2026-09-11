import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

function source(name:string){
  return readFileSync(new URL(`./${name}`,import.meta.url),'utf8');
}

function body(file:string,startMarker:string,endMarker:string){
  const text=source(file);
  const start=text.indexOf(startMarker);
  const end=endMarker?text.indexOf(endMarker,start):text.length;
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return text.slice(start,end);
}

describe('operational projection serialization',()=>{
  it('serializes mobility mutations on the service case before allocation locking',()=>{
    for(const [start,end] of [
      ['export async function assignMobility','export async function updateMobilityState'],
      ['export async function updateMobilityState','export async function listMobilityForCase']
    ] as const){
      const fn=body('mobility.ts',start,end);
      const discover=fn.indexOf('select case_id from mobility_allocations where id=$1');
      const caseLock=fn.indexOf('await lockServiceCase(caseId,client)');
      const sourceLock=fn.indexOf('select * from mobility_allocations where id=$1 for update');
      const projection=fn.indexOf('await syncMobilityOperationalConstraint(caseId,client)');
      expect(discover).toBeGreaterThanOrEqual(0);
      expect(caseLock).toBeGreaterThan(discover);
      expect(sourceLock).toBeGreaterThan(caseLock);
      expect(projection).toBeGreaterThan(sourceLock);
    }
  });

  it('serializes approval mutations on the service case before approval projection refresh',()=>{
    for(const [start,end] of [
      ['export async function reviseServicePlan','export async function decideApproval'],
      ['export async function decideApproval','']
    ] as const){
      const fn=body('service-plan.ts',start,end);
      const caseLock=fn.indexOf('await lockServiceCase(caseId,client)');
      const projection=fn.indexOf('await syncApprovalOperationalConstraint(caseId,client)');
      expect(caseLock).toBeGreaterThanOrEqual(0);
      expect(projection).toBeGreaterThan(caseLock);
    }
  });

  it('serializes transport mutations on the service case before dispatch locking',()=>{
    for(const [start,end] of [
      ['export async function assignTransportDispatch','export async function updateTransportStatus'],
      ['export async function updateTransportStatus','export async function getTransportDispatch']
    ] as const){
      const fn=body('transport.ts',start,end);
      const discover=fn.indexOf('select case_id from transport_dispatches where id=$1');
      const caseLock=fn.indexOf('await lockServiceCase(caseId,client)');
      const sourceLock=fn.indexOf('select * from transport_dispatches where id=$1 for update');
      const projection=fn.indexOf('await syncTransportOperationalConstraint(caseId,client)');
      expect(discover).toBeGreaterThanOrEqual(0);
      expect(caseLock).toBeGreaterThan(discover);
      expect(sourceLock).toBeGreaterThan(caseLock);
      expect(projection).toBeGreaterThan(sourceLock);
    }
  });

  it('locks deferred-service case before item and appointment when booking',()=>{
    const fn=body('shop-os-completion.ts','export async function updateDeferredService','export async function reconcileRepairOrder');
    const caseLock=fn.indexOf('await lockServiceCase(discoveredCaseId,client)');
    const itemLock=fn.indexOf('select * from shop_deferred_service_items where id=$1 for update');
    const appointmentLock=fn.indexOf('from roviq_appointments where id=$1 for update');
    expect(caseLock).toBeGreaterThanOrEqual(0);
    expect(itemLock).toBeGreaterThan(caseLock);
    expect(appointmentLock).toBeGreaterThan(itemLock);
  });

  it('serializes parts projection mutations on the service case',()=>{
    for(const [start,end] of [
      ['export async function createRepairOrderPartRequirement','export async function updateRepairOrderPartRequirement'],
      ['export async function updateRepairOrderPartRequirement','export async function listRepairOrderPartRequirements']
    ] as const){
      const fn=body('shop-os-completion.ts',start,end);
      const caseLock=fn.indexOf('await lockServiceCase(caseId,client)');
      const projection=fn.indexOf('await syncPartsOperationalConstraint(caseId,client)');
      expect(caseLock).toBeGreaterThanOrEqual(0);
      expect(projection).toBeGreaterThan(caseLock);
    }
  });
});
