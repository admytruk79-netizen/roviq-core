import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

const source=readFileSync(new URL('./shop-os.ts',import.meta.url),'utf8');

describe('Shop OS scheduling lock order',()=>{
  it('locks the linked service case before resource locking in appointment creation',()=>{
    const start=source.indexOf('export async function createShopOsAppointment');
    const end=source.indexOf('export async function updateShopOsAppointment',start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const createBody=source.slice(start,end);

    const caseLock=createBody.indexOf('await lockSchedulingCase(input.serviceCaseId,client)');
    const resourceLoad=createBody.indexOf('await loadManageableResource(principal,input.resourceId,client)');
    const resourceLock=createBody.indexOf('await lockSchedulingResources([input.resourceId],client)');

    expect(caseLock).toBeGreaterThanOrEqual(0);
    expect(resourceLoad).toBeGreaterThan(caseLock);
    expect(resourceLock).toBeGreaterThan(caseLock);
  });

  it('implements the case lock as a row-level FOR UPDATE lock',()=>{
    const start=source.indexOf('export async function lockSchedulingCase');
    const end=source.indexOf('async function assertManageableServiceCase',start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const helper=source.slice(start,end);
    expect(helper).toContain('from service_cases where id=$1 for update');
  });
});
