import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

const transport=readFileSync(new URL('./transport.ts',import.meta.url),'utf8');
const orchestration=readFileSync(new URL('./orchestration.ts',import.meta.url),'utf8');
const migration=readFileSync(new URL('../../migrations/049_transport_provider_aware_destination_projection.sql',import.meta.url),'utf8');

describe('transport transaction invariants',()=>{
  it('performs dispatch creation and tow-pending transition before one commit',()=>{
    const start=transport.indexOf('export async function createTransportDispatch');
    const end=transport.indexOf('export async function assignTransportDispatch',start);
    const body=transport.slice(start,end);

    const insert=body.indexOf('insert into transport_dispatches');
    const transition=body.indexOf("transitionCase(principal,input.caseId,'tow_pending'");
    const projection=body.indexOf('syncTransportOperationalConstraint(input.caseId,client)');
    const commit=body.indexOf("client.query('commit')");

    expect(insert).toBeGreaterThanOrEqual(0);
    expect(transition).toBeGreaterThan(insert);
    expect(body.slice(transition,projection)).toContain(',client)');
    expect(projection).toBeGreaterThan(transition);
    expect(commit).toBeGreaterThan(projection);
  });

  it('performs accepted-to-tow-in-progress transition in the transport transaction',()=>{
    const start=transport.indexOf('export async function updateTransportStatus');
    const end=transport.indexOf('export async function getTransportDispatch',start);
    const body=transport.slice(start,end);
    const transition=body.indexOf("transitionCase(principal,caseId,'tow_in_progress'");
    const projection=body.indexOf('syncTransportOperationalConstraint(caseId,client)');
    const commit=body.indexOf("client.query('commit')");

    expect(transition).toBeGreaterThanOrEqual(0);
    expect(body.slice(transition,projection)).toContain(',client)');
    expect(projection).toBeGreaterThan(transition);
    expect(commit).toBeGreaterThan(projection);
  });

  it('lets case transitions participate in a caller-owned transaction',()=>{
    expect(orchestration).toContain('transactionClient?:PoolClient');
    expect(orchestration).toContain('const client = transactionClient ?? await pool.connect()');
    expect(orchestration).toContain('const ownsTransaction = !transactionClient');
  });

  it('keeps destination-triggered projections provider-aware',()=>{
    expect(migration).toContain('left join actors a on a.id=td.provider_actor_id');
    expect(migration).toContain("a.status as provider_status");
    expect(migration).toContain("provider_ready:=latest.provider_actor_id is not null and latest.provider_status='active'");
    expect(migration).toContain("latest.status in ('accepted','en_route','arrived','vehicle_loaded','in_transit') and not provider_ready then 'blocked'");
    expect(migration).toContain("latest.status in ('accepted','en_route','arrived','vehicle_loaded','in_transit','delivered') then 'satisfied'");
    expect(migration).toContain("'providerStatus',latest.provider_status");
  });
});
