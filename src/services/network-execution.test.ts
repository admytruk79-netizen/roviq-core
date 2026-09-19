import { describe, expect, it } from 'vitest';
import {
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
});
