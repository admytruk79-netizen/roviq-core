export const CORE_CASE_TRANSITIONS:Record<string,ReadonlySet<string>>={
  intake:new Set(['triage','waiting_external','cancelled']),
  triage:new Set(['active','waiting_external','needs_review','cancelled']),
  active:new Set(['waiting_external','needs_review','blocked','completed','cancelled']),
  waiting_external:new Set(['active','needs_review','blocked','expired','cancelled']),
  needs_review:new Set(['active','blocked','cancelled']),
  blocked:new Set(['active','cancelled']),
  retry_scheduled:new Set(['active','degraded','failed']),
  degraded:new Set(['active','retry_scheduled','needs_review','failed']),
  failed:new Set(['retry_scheduled','cancelled'])
};
export const CORE_TERMINAL_STATES=new Set(['completed','cancelled','expired']);

export function coreCaseTransitions(state:string){
  return [...(CORE_CASE_TRANSITIONS[state]??[])];
}
export function coreCaseTransitionAllowed(from:string,to:string){
  return CORE_CASE_TRANSITIONS[from]?.has(to)??false;
}
export function coreCaseIsTerminal(state:string){
  return CORE_TERMINAL_STATES.has(state);
}
