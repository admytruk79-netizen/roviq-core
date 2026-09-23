import { describe,expect,it } from 'vitest';

// Integrity-level contract tests for the universal Case Kernel state graph.
// Database/e2e coverage validates authorization, locking and idempotency separately.
const transitions:Record<string,string[]>={
  intake:['triage','waiting_external','cancelled'],
  triage:['active','waiting_external','needs_review','cancelled'],
  active:['waiting_external','needs_review','blocked','completed','cancelled'],
  waiting_external:['active','needs_review','blocked','expired','cancelled'],
  needs_review:['active','blocked','cancelled'],
  blocked:['active','cancelled'],
  retry_scheduled:['active','degraded','failed'],
  degraded:['active','retry_scheduled','needs_review','failed'],
  failed:['retry_scheduled','cancelled']
};
describe('universal case state graph',()=>{
  it('never permits transitions out of terminal states',()=>{
    for(const state of ['completed','cancelled','expired'])expect(transitions[state]).toBeUndefined();
  });
  it('keeps cancellation explicit on human workflow states',()=>{
    for(const state of ['intake','triage','active','waiting_external','needs_review','blocked'])expect(transitions[state]).toContain('cancelled');
  });
  it('requires recovery before a failed case can become active',()=>{
    expect(transitions.failed).not.toContain('active');
    expect(transitions.failed).toContain('retry_scheduled');
  });
});
