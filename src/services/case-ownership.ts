export type CaseOwnerRole='customer'|'admin'|'diagnostic'|'tow'|'partner'|'parts'|null;

export type CaseOwnershipInput={
  state:string;
  customerActorId?:string|null;
  selectedActorId?:string|null;
};

export type CaseOwnership={
  role:CaseOwnerRole;
  actorId:string|null;
};

/**
 * Deterministic ownership projection for the shared Service Case.
 * This does not create a second workflow; it makes the existing canonical
 * case state explicit to every role projection.
 */
export function deriveCaseOwnership(input:CaseOwnershipInput):CaseOwnership{
  switch(input.state){
    case 'intake':
      return {role:'customer',actorId:input.customerActorId??null};
    case 'triage':
    case 'provider_selection':
    case 'payment_pending':
      return {role:'admin',actorId:null};
    case 'diagnostic_pending':
    case 'diagnostic_in_progress':
      return {role:'diagnostic',actorId:null};
    case 'tow_pending':
    case 'tow_in_progress':
      return {role:'tow',actorId:null};
    case 'provider_pending':
    case 'repair_in_progress':
      return {role:'partner',actorId:input.selectedActorId??null};
    case 'parts_pending':
      return {role:'parts',actorId:null};
    case 'completed':
    case 'cancelled':
      return {role:null,actorId:null};
    default:
      return {role:null,actorId:null};
  }
}
