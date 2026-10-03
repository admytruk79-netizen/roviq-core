import type {AscendProductionStatus} from "./ascend-production.js";
export interface ManufacturingEvent {
 eventId:string;jobId:string;occurredAt:string;from:AscendProductionStatus;to:AscendProductionStatus;
 actorId:string;idempotencyKey:string;metadata:Readonly<Record<string,string>>;
}
const NEXT:Record<AscendProductionStatus,readonly AscendProductionStatus[]>={
 "package-generated":["manufacturer-accepted"],"manufacturer-accepted":["in-production"],"in-production":["qc-passed"],"qc-passed":["shipped"],"shipped":["delivered"],"delivered":[]
};
export function appendManufacturingTransition(input:ManufacturingEvent):ManufacturingEvent{
 if(!input.eventId||!input.jobId||!input.actorId||!input.idempotencyKey||!input.occurredAt)throw new Error("complete audit identity required");
 if(!NEXT[input.from].includes(input.to))throw new Error(`illegal manufacturing transition: ${input.from} -> ${input.to}`);
 return Object.freeze({...input,metadata:Object.freeze({...input.metadata})});
}
