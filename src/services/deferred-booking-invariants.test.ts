import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

const completion=readFileSync(new URL('./shop-os-completion.ts',import.meta.url),'utf8');
const migration=readFileSync(new URL('../../migrations/049_transport_provider_aware_destination_projection.sql',import.meta.url),'utf8');

describe('deferred booking and transport projection invariants',()=>{
  it('validates appointment category without taking the repair-line row lock',()=>{
    const start=completion.indexOf('export async function updateDeferredService');
    const end=completion.indexOf('export async function reconcileRepairOrder',start);
    const body=completion.slice(start,end);

    expect(body).toContain('l.service_category as deferred_service_category');
    expect(body).toContain('for update of d`');
    expect(body).not.toContain('for update of d,l');
    expect(body).toContain('appointment_status,service_category from roviq_appointments');
    expect(body).toContain("a.service_category!==row.deferred_service_category");
    expect(body).toContain("deferred_service_appointment_category_mismatch");
  });

  it('removes stale transport projections when no non-cancelled dispatch remains',()=>{
    expect(migration).toContain("delete from case_constraints cc");
    expect(migration).toContain("cc.projection_key='transport-readiness'");
    expect(migration).toContain("cc.source_type='operational_projection'");
    expect(migration).toContain("not exists (");
    expect(migration).toContain("td.case_id=cc.service_case_id");
    expect(migration).toContain("td.status<>'cancelled'");
  });
});
