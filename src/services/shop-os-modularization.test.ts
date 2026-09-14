import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

const route=readFileSync(new URL('../http/routes/shop-os.ts',import.meta.url),'utf8');
const create=readFileSync(new URL('./shop-os-appointment-create.ts',import.meta.url),'utf8');
const update=readFileSync(new URL('./shop-os-appointment-update.ts',import.meta.url),'utf8');
const serviceability=readFileSync(new URL('./shop-os-serviceability.ts',import.meta.url),'utf8');

describe('Shop OS modular scheduling architecture',()=>{
  it('routes appointment commands through focused application services',()=>{
    expect(route).toContain("from '../../services/shop-os-appointment-create.js'");
    expect(route).toContain("from '../../services/shop-os-appointment-update.js'");
    expect(route).toContain("from '../../services/shop-os-schedule-query.js'");
  });

  it('does not broadly rebuild operational constraints during scheduling checks',()=>{
    expect(serviceability).not.toContain('syncOperationalConstraints');
    expect(serviceability).toContain('from case_constraints where service_case_id=$1');
  });

  it('refreshes only customer-time projection after appointment mutations',()=>{
    expect(create).toContain('syncCustomerTimeOperationalConstraint(input.serviceCaseId,client)');
    expect(update).toContain('syncCustomerTimeOperationalConstraint(existing.service_case_id,client)');
  });

  it('revalidates resource and connector under lock before starting work',()=>{
    const startBranch=update.indexOf("input.action==='start'");
    expect(startBranch).toBeGreaterThanOrEqual(0);
    expect(update).toContain("lockSchedulingResources([existing.resource_id,nextResourceId],client)");
    expect(update).toContain('assertUsableShopOsResource(nextResourceId,nextResource.shop_os_connection_id,client)');
  });

  it('rejects chained recovery appointments before insert',()=>{
    const rootGuard=create.indexOf('recoverySource.recovery_source_appointment_id');
    const insert=create.indexOf('insert into roviq_appointments');
    expect(rootGuard).toBeGreaterThanOrEqual(0);
    expect(insert).toBeGreaterThan(rootGuard);
    expect(create).toContain("httpError('shop_os_recovery_source_not_root',409)");
  });
});
