import { describe,expect,it } from 'vitest';
import { policyPredicateMatches } from '../src/services/core-policy.js';

describe('Core policy predicate evaluator',()=>{
  const facts={
    case:{type:'trade',state:'active',priority:'high',constraints:{exportDocsRequired:true}},
    actor:{role:'partner'},
    transition:{to:'waiting_external'},
    evidence:{documents:['title','invoice']}
  };
  it('supports exact and nested path checks',()=>{
    expect(policyPredicateMatches({'case.type':{eq:'trade'},'case.constraints.exportDocsRequired':true},facts)).toBe(true);
  });
  it('supports membership and array containment without executing arbitrary code',()=>{
    expect(policyPredicateMatches({'actor.role':{in:['partner','admin']},'evidence.documents':{contains:'title'}},facts)).toBe(true);
  });
  it('fails closed for unmet predicates',()=>{
    expect(policyPredicateMatches({'transition.to':{eq:'completed'}},facts)).toBe(false);
    expect(policyPredicateMatches({'case.constraints.missing':{exists:true}},facts)).toBe(false);
  });
  it('can require current approval evidence through ordinary facts',()=>{
    const completionFacts={
      case:{constraints:{customerApprovalRequired:true}},
      approval:{valid:false},
      transition:{to:'completed'}
    };
    expect(policyPredicateMatches({
      'case.constraints.customerApprovalRequired':{eq:true},
      'approval.valid':{neq:true}
    },completionFacts)).toBe(true);
    expect(policyPredicateMatches({
      'case.constraints.customerApprovalRequired':{eq:true},
      'approval.valid':{neq:true}
    },{...completionFacts,approval:{valid:true}})).toBe(false);
  });
});
