import { describe,expect,it } from 'vitest';
import { coreCaseIsTerminal,coreCaseTransitionAllowed,coreCaseTransitions } from '../src/services/core-case-state.js';

describe('universal case state graph',()=>{
  it('never permits transitions out of terminal states',()=>{
    for(const state of ['completed','cancelled','expired']){
      expect(coreCaseIsTerminal(state)).toBe(true);
      expect(coreCaseTransitions(state)).toEqual([]);
    }
  });
  it('keeps cancellation explicit on human workflow states',()=>{
    for(const state of ['intake','triage','active','waiting_external','needs_review','blocked']){
      expect(coreCaseTransitionAllowed(state,'cancelled')).toBe(true);
    }
  });
  it('requires recovery before a failed case can become active',()=>{
    expect(coreCaseTransitionAllowed('failed','active')).toBe(false);
    expect(coreCaseTransitionAllowed('failed','retry_scheduled')).toBe(true);
  });
  it('uses the same graph exposed to the UI and enforced by commands',()=>{
    expect(coreCaseTransitions('active')).toEqual(['waiting_external','needs_review','blocked','completed','cancelled']);
  });
});
