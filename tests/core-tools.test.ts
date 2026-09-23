import { describe,expect,it } from 'vitest';
import { assertCoreToolAllowed, coreToolRegistry } from '../src/services/core-tools.js';

describe('controlled Core tool registry',()=>{
  it('contains only explicit allowlisted tools',()=>{
    expect(coreToolRegistry.map(t=>t.name).sort()).toEqual(['approval.list','approval.request','case.read']);
  });
  it('requires explicit confirmation for mutations',()=>{
    expect(()=>assertCoreToolAllowed({role:'partner',actorId:'00000000-0000-0000-0000-000000000001'},'approval.request',{caseId:'x'}))
      .toThrow('confirmation_required');
    expect(assertCoreToolAllowed({role:'partner',actorId:'00000000-0000-0000-0000-000000000001'},'approval.request',{confirmed:true}).mutates)
      .toBe(true);
  });
  it('blocks roles that are not permitted to request approvals',()=>{
    expect(()=>assertCoreToolAllowed({role:'customer',actorId:'00000000-0000-0000-0000-000000000001'},'approval.request',{confirmed:true}))
      .toThrow('tool_forbidden');
  });
  it('rejects unknown tool names',()=>{
    expect(()=>assertCoreToolAllowed({role:'admin'},'case.forceComplete',{confirmed:true})).toThrow('tool_not_allowed');
  });
});
