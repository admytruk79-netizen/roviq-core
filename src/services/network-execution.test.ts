import { describe, expect, it } from 'vitest';
import {
  completionBlockers,
  handoffStatusForMobility,
  handoffStatusForParts,
  handoffStatusForTransport
} from './network-execution.js';

describe('network execution handoff status mapping',()=>{
  it('maps transport lifecycle into canonical handoff states',()=>{
    expect(handoffStatusForTransport('assigned')).toBe('assigned');
    expect(handoffStatusForTransport('accepted')).toBe('accepted');
    expect(handoffStatusForTransport('en_route')).toBe('in_progress');
    expect(handoffStatusForTransport('in_transit')).toBe('in_progress');
    expect(handoffStatusForTransport('delivered')).toBe('completed');
    expect(handoffStatusForTransport('declined')).toBe('declined');
    expect(handoffStatusForTransport('failed')).toBe('failed');
  });

  it('maps mobility lifecycle into canonical handoff states',()=>{
    expect(handoffStatusForMobility('requested')).toBe('planned');
    expect(handoffStatusForMobility('assigned')).toBe('assigned');
    expect(handoffStatusForMobility('active')).toBe('in_progress');
    expect(handoffStatusForMobility('return_pending')).toBe('in_progress');
    expect(handoffStatusForMobility('completed')).toBe('completed');
  });

  it('maps parts lifecycle into canonical handoff states',()=>{
    expect(handoffStatusForParts('requested')).toBe('planned');
    expect(handoffStatusForParts('supplier_assigned')).toBe('assigned');
    expect(handoffStatusForParts('reserved')).toBe('in_progress');
    expect(handoffStatusForParts('shipped')).toBe('in_progress');
    expect(handoffStatusForParts('delivered')).toBe('completed');
    expect(handoffStatusForParts('cancelled')).toBe('cancelled');
  });
  it('blocks completion on unresolved constraints and non-terminal handoffs',()=>{
    const blockers=completionBlockers({
      constraints:[
        {constraint_type:'parts',status:'satisfied',projection_key:'parts-readiness'},
        {constraint_type:'authorization',status:'required',projection_key:'repair-authorization'}
      ],
      handoffs:[
        {handoff_type:'service_provider',status:'completed',reference_type:'match_offer',reference_id:'offer-1'},
        {handoff_type:'transport',status:'in_progress',reference_type:'transport_dispatch',reference_id:'dispatch-1'},
        {handoff_type:'mobility',status:'cancelled',reference_type:'mobility_allocation',reference_id:'mobility-1'}
      ]
    });
    expect(blockers).toHaveLength(2);
    expect(blockers.map((blocker)=>[blocker.kind,blocker.type,blocker.status])).toEqual([
      ['constraint','authorization','required'],
      ['handoff','transport','in_progress']
    ]);
  });

  it('treats completed or explicitly cancelled handoffs as terminal when canonical constraints are clear',()=>{
    const blockers=completionBlockers({
      constraints:[
        {constraint_type:'parts',status:'satisfied'},
        {constraint_type:'mobility',status:'waived'}
      ],
      handoffs:[
        {handoff_type:'parts',status:'completed'},
        {handoff_type:'mobility',status:'cancelled'}
      ]
    });
    expect(blockers).toEqual([]);
  });
});
