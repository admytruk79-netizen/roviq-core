import { describe, expect, it } from 'vitest';
import {
  deriveCanonicalSyncState,
  evaluateActorServiceability,
  evaluateCanonicalWindows,
  resolveServiceTargetAt,
  type CanonicalWindowRow
} from './serviceability-gate.js';

function row(overrides:Partial<CanonicalWindowRow>={}):CanonicalWindowRow {
  return {
    id:'window-default',
    capacity_state:'available',
    confidence:'integrated',
    sync_state:'current',
    capacity_units:2,
    updated_at:'2026-09-04T22:59:00Z',
    source_connection_id:'11111111-1111-1111-1111-111111111111',
    connection_mode:'native_integration',
    connection_status:'active',
    connection_last_success_at:'2026-09-04T22:59:00Z',
    service_category:'repair',
    ...overrides
  };
}

describe('canonical serviceability gate',()=>{
  it('ages a formerly current native window to stale and then degraded without rewriting it',()=>{
    const staleNow=new Date('2026-09-04T23:20:00Z');
    const degradedNow=new Date('2026-09-05T00:01:01Z');
    const stored=row({connection_last_success_at:'2026-09-04T23:00:00Z',updated_at:'2026-09-04T23:00:00Z'});

    expect(deriveCanonicalSyncState(stored,staleNow)).toBe('stale');
    const stale=evaluateCanonicalWindows([stored],[],'confirm','repair',staleNow);
    expect(stale?.decision.confirmable).toBe(false);
    expect(stale?.decision.reasons).toContain('sync_stale');

    expect(deriveCanonicalSyncState(stored,degradedNow)).toBe('degraded');
    const degraded=evaluateCanonicalWindows([stored],[],'route','repair',degradedNow);
    expect(degraded?.decision.eligible).toBe(false);
    expect(degraded?.decision.reasons).toContain('sync_degraded');
  });

  it('preserves stale and degraded Shop OS sync states instead of upgrading them to current',()=>{
    const now=new Date('2026-09-05T00:00:00Z');
    const staleNative=row({connection_mode:'roviq_native',confidence:'roviq_native',sync_state:'stale',connection_last_success_at:null});
    const degradedNative=row({id:'native-degraded',connection_mode:'roviq_native',confidence:'roviq_native',sync_state:'degraded',connection_last_success_at:null});

    expect(deriveCanonicalSyncState(staleNative,now)).toBe('stale');
    expect(deriveCanonicalSyncState(degradedNative,now)).toBe('degraded');
    expect(evaluateCanonicalWindows([staleNative],[],'confirm','repair',now)?.decision.confirmable).toBe(false);
    expect(evaluateCanonicalWindows([degradedNative],[],'confirm','repair',now)?.decision.confirmable).toBe(false);
  });

  it('chooses a usable lower-unit window when a higher-unit overlapping window is blocked',()=>{
    const now=new Date('2026-09-04T23:00:00Z');
    const blocked=row({id:'blocked-10',capacity_state:'blocked',capacity_units:10});
    const available=row({id:'available-2',capacity_state:'available',capacity_units:2});
    const result=evaluateCanonicalWindows([blocked,available],[],'confirm','repair',now);

    expect(result?.capacityWindowId).toBe('available-2');
    expect(result?.capacityUnits).toBe(2);
    expect(result?.decision.confirmable).toBe(true);
  });

  it('does not allow capacity from another service category to confirm a selection',()=>{
    const now=new Date('2026-09-04T23:00:00Z');
    const repair=row({id:'repair-window',service_category:'repair',capacity_state:'available'});
    const diagnostics=row({id:'diagnostics-window',service_category:'diagnostics',capacity_state:'blocked'});
    const result=evaluateCanonicalWindows([repair,diagnostics],[],'confirm','diagnostics',now);

    expect(result?.capacityWindowId).toBe('diagnostics-window');
    expect(result?.decision.confirmable).toBe(false);
    expect(result?.decision.reasons).toContain('capacity_blocked');
  });

  it('returns canonical units for routing instead of relying on legacy snapshots',()=>{
    const now=new Date('2026-09-04T23:00:00Z');
    const integrated=row({id:'canonical-4',capacity_units:4});
    const result=evaluateCanonicalWindows([integrated],[],'route','repair',now);

    expect(result?.source).toBe('canonical_capacity');
    expect(result?.capacityUnits).toBe(4);
    expect(result?.decision.eligible).toBe(true);
  });

  it('resolves the requested category appointment and ignores simultaneous unrelated appointments',async()=>{
    let sql=''; let params:unknown[]=[];
    const db:any={query:async(query:string,values:unknown[])=>{
      sql=query;params=values;
      return {rowCount:1,rows:[{service_target_at:'2026-09-12T17:30:00.000Z'}]};
    }};
    const target=await resolveServiceTargetAt(
      '11111111-1111-1111-1111-111111111111',
      db,
      new Date('2026-09-07T20:00:00.000Z'),
      'repair'
    );
    expect(target.toISOString()).toBe('2026-09-12T17:30:00.000Z');
    expect(params[1]).toBe('repair');
    expect(sql).toContain('ra.service_category=$2::text');
    expect(sql).toContain("when 'in_progress' then 0");
  });

  it('falls back to canonical case/demand requested service time when no matching category appointment exists',async()=>{
    const db:any={query:async()=>({rowCount:1,rows:[{service_target_at:'2026-09-14T15:00:00.000Z'}]})};
    const target=await resolveServiceTargetAt(
      '11111111-1111-1111-1111-111111111111',db,new Date('2026-09-07T20:00:00.000Z'),'diagnostics'
    );
    expect(target.toISOString()).toBe('2026-09-14T15:00:00.000Z');
  });

  it('falls back to immediate service when no valid scheduled target exists',async()=>{
    const now=new Date('2026-09-07T20:00:00.000Z');
    const db:any={query:async()=>({rowCount:1,rows:[{service_target_at:'not-a-date'}]})};
    const target=await resolveServiceTargetAt('11111111-1111-1111-1111-111111111111',db,now,'repair');
    expect(target).toBe(now);
  });

  it('allows a location actor to use organization-global canonical capacity',async()=>{
    const queries:string[]=[];
    const db:any={query:async(sql:string)=>{
      queries.push(sql);
      if(queries.length===1) return {rowCount:1,rows:[{organization_id:'22222222-2222-2222-2222-222222222222',location_id:'33333333-3333-3333-3333-333333333333',status:'active',has_connection_model:true,has_active_capability:true}]};
      return {rowCount:1,rows:[row({id:'org-global',capacity_units:3})]};
    }};
    const result=await evaluateActorServiceability(null,'44444444-4444-4444-4444-444444444444','repair','confirm',db,new Date('2026-09-04T23:00:00Z'));
    expect(result.capacityWindowId).toBe('org-global');
    expect(result.capacityUnits).toBe(3);
    expect(queries[0]).toContain('psc.organization_id=a.organization_id and psc.location_id is null');
    expect(queries[0]).toContain('ac.active=true');
    expect(queries[1]).toContain('cw.organization_id=$2 and cw.location_id is null');
  });

  it('fails closed when the candidate provider is inactive even when capacity is available',async()=>{
    const db:any={query:async(sql:string)=>{
      if(sql.includes('from actors')) return {rowCount:1,rows:[{organization_id:'22222222-2222-2222-2222-222222222222',location_id:null,status:'inactive',has_connection_model:true,has_active_capability:true}]};
      if(sql.includes('from capacity_windows')) return {rowCount:1,rows:[row({id:'inactive-provider-capacity'})]};
      throw new Error(`unexpected query: ${sql}`);
    }};
    const result=await evaluateActorServiceability(null,'44444444-4444-4444-4444-444444444444','repair','confirm',db,new Date('2026-09-04T23:00:00Z'));
    expect(result.decision.confirmable).toBe(false);
    expect(result.decision.reasons).toContain('constraint_provider_blocked');
  });

  it('fails closed when the candidate provider lacks an active requested capability',async()=>{
    const db:any={query:async(sql:string)=>{
      if(sql.includes('from actors')) return {rowCount:1,rows:[{organization_id:'22222222-2222-2222-2222-222222222222',location_id:null,status:'active',has_connection_model:true,has_active_capability:false}]};
      if(sql.includes('from capacity_windows')) return {rowCount:1,rows:[row({id:'missing-capability-capacity'})]};
      throw new Error(`unexpected query: ${sql}`);
    }};
    const result=await evaluateActorServiceability(null,'44444444-4444-4444-4444-444444444444','repair','confirm',db,new Date('2026-09-04T23:00:00Z'));
    expect(result.decision.confirmable).toBe(false);
    expect(result.decision.reasons).toContain('constraint_capability_blocked');
  });

  it('does not fall back to legacy capacity after an actor has entered the canonical connection model',async()=>{
    const db:any={query:async(sql:string)=>{
      if(sql.includes('from actors')) return {rowCount:1,rows:[{organization_id:'22222222-2222-2222-2222-222222222222',location_id:'33333333-3333-3333-3333-333333333333',status:'active',has_connection_model:true,has_active_capability:true}]};
      if(sql.includes('from capacity_windows')) return {rowCount:0,rows:[]};
      throw new Error('legacy capacity should not be queried');
    }};
    const result=await evaluateActorServiceability(null,'44444444-4444-4444-4444-444444444444','repair','route',db,new Date('2026-09-04T23:00:00Z'));
    expect(result.source).toBe('missing');
    expect(result.decision.eligible).toBe(false);
  });
});
