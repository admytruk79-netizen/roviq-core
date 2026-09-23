import { describe,expect,it } from 'vitest';
import { tradePhaseAllowed } from '../src/services/trade-case.js';

describe('TradeCase phase graph',()=>{
  it('follows the intended forward workflow',()=>{
    expect(tradePhaseAllowed('sourcing','verification')).toBe(true);
    expect(tradePhaseAllowed('verification','commercial_quote')).toBe(true);
    expect(tradePhaseAllowed('commercial_quote','approval')).toBe(true);
    expect(tradePhaseAllowed('approval','compliance_documents')).toBe(true);
    expect(tradePhaseAllowed('compliance_documents','freight_booking')).toBe(true);
    expect(tradePhaseAllowed('freight_booking','in_transit')).toBe(true);
    expect(tradePhaseAllowed('in_transit','destination_handoff')).toBe(true);
    expect(tradePhaseAllowed('destination_handoff','completed')).toBe(true);
  });
  it('blocks unsafe workflow skips',()=>{
    expect(tradePhaseAllowed('sourcing','freight_booking')).toBe(false);
    expect(tradePhaseAllowed('verification','in_transit')).toBe(false);
    expect(tradePhaseAllowed('in_transit','completed')).toBe(false);
  });
  it('does not reopen terminal states',()=>{
    expect(tradePhaseAllowed('completed','sourcing')).toBe(false);
    expect(tradePhaseAllowed('cancelled','sourcing')).toBe(false);
  });
});
