import { describe, expect, it } from 'vitest';
import {
  deriveCanonicalSyncState,
  evaluateCanonicalWindows,
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
});
