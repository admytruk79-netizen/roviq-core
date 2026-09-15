import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

const createSource=readFileSync(new URL('./shop-os-appointment-create.ts',import.meta.url),'utf8');
const updateSource=readFileSync(new URL('./shop-os-appointment-update.ts',import.meta.url),'utf8');
const capacitySource=readFileSync(new URL('./shop-os-capacity.ts',import.meta.url),'utf8');

describe('Shop OS scheduling lock order',()=>{
  it('locks the linked service case before resource locking in appointment creation',()=>{
    const caseLock=createSource.indexOf('await lockSchedulingCase(input.serviceCaseId,client)');
    const resourceLoad=createSource.indexOf('await loadManageableShopOsResource(principal,input.resourceId,client)');
    const resourceLock=createSource.indexOf('await lockSchedulingResources([input.resourceId],client)');

    expect(caseLock).toBeGreaterThanOrEqual(0);
    expect(resourceLoad).toBeGreaterThan(caseLock);
    expect(resourceLock).toBeGreaterThan(caseLock);
  });

  it('locks the linked service case before the appointment and resources on every update action',()=>{
    const preview=updateSource.indexOf('select service_case_id from roviq_appointments where id=$1');
    const caseLock=updateSource.indexOf('await lockSchedulingCase(previewCaseId,client)');
    const appointmentLock=updateSource.indexOf('select * from roviq_appointments where id=$1 for update');
    const resourceLock=updateSource.indexOf('await lockSchedulingResources([existing.resource_id,nextResourceId],client)');

    expect(preview).toBeGreaterThanOrEqual(0);
    expect(caseLock).toBeGreaterThan(preview);
    expect(appointmentLock).toBeGreaterThan(caseLock);
    expect(resourceLock).toBeGreaterThan(appointmentLock);

    // The resource lock must not be gated behind a subset of actions -- every action ends up
    // rebuilding capacity for the resource, so cancel/release/no_show/complete must serialize on
    // the resource the same way reschedule/confirm/start do, or concurrent operations against the
    // same resource can take these locks in different orders and deadlock.
    expect(updateSource).not.toMatch(/\[['"]reschedule['"],\s*['"]confirm['"],\s*['"]start['"]\]\.includes\(input\.action\)\)\s*\{\s*\n?\s*await lockSchedulingResources/);
  });

  it('implements the case lock as a row-level FOR UPDATE lock and rejects scheduling against a terminal case',()=>{
    const start=capacitySource.indexOf('export async function lockSchedulingCase');
    const end=capacitySource.indexOf('export async function lockSchedulingResources',start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const helper=capacitySource.slice(start,end);
    expect(helper).toContain('from service_cases where id=$1 for update');
    expect(helper).toContain("['cancelled','completed'].includes");
  });
});
