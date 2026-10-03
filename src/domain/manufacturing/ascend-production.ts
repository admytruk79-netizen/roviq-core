export type AscendProductionStatus="package-generated"|"manufacturer-accepted"|"in-production"|"qc-passed"|"shipped"|"delivered";
export interface AscendProductionJobInput {
 externalJobId:string; designId:string; designVersion:number; packageId:string; packageHash:string;
 manufacturerId:string; capabilityProfileVersion:string; status:AscendProductionStatus;
}
export interface ManufacturingJob {
 id:string; domain:"apparel-manufacturing"; externalRef:string; designRef:string; packageRef:string;
 assignedActorId:string; capabilityProfileVersion:string; status:AscendProductionStatus;
}
export function createAscendManufacturingJob(i:AscendProductionJobInput):ManufacturingJob{
 if(!i.externalJobId||!i.designId||i.designVersion<1||!i.packageId||!i.manufacturerId)throw new Error("invalid ASCEND production handoff");
 if(!/^[a-f0-9]{64}$/i.test(i.packageHash))throw new Error("packageHash must be sha256");
 if(i.status!=="package-generated")throw new Error("new manufacturing job must begin at package-generated");
 return Object.freeze({id:i.externalJobId,domain:"apparel-manufacturing",externalRef:i.externalJobId,designRef:`${i.designId}:v${i.designVersion}`,packageRef:`${i.packageId}@${i.packageHash}`,assignedActorId:i.manufacturerId,capabilityProfileVersion:i.capabilityProfileVersion,status:i.status});
}
