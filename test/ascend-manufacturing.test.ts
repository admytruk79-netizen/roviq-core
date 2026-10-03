import {describe,it,expect} from "vitest";
import {createAscendManufacturingJob} from "../src/domain/manufacturing/ascend-production";
import {appendManufacturingTransition} from "../src/domain/manufacturing/ascend-events";
describe("ASCEND manufacturing handoff",()=>{
 it("creates a package-bound manufacturing job",()=>expect(createAscendManufacturingJob({externalJobId:"job-1",designId:"ASC-1",designVersion:1,packageId:"ASC-1:v1",packageHash:"a".repeat(64),manufacturerId:"factory-1",capabilityProfileVersion:"1",status:"package-generated"}).designRef).toBe("ASC-1:v1"));
 it("requires jobs to enter at package-generated",()=>expect(()=>createAscendManufacturingJob({externalJobId:"job-1",designId:"ASC-1",designVersion:1,packageId:"p",packageHash:"a".repeat(64),manufacturerId:"f",capabilityProfileVersion:"1",status:"in-production"})).toThrow());
 it("records guarded immutable manufacturing transitions",()=>expect(appendManufacturingTransition({eventId:"e1",jobId:"j1",occurredAt:"2026-10-02T00:00:00Z",from:"qc-passed",to:"shipped",actorId:"factory-1",idempotencyKey:"ship:j1",metadata:{tracking:"pending"}}).to).toBe("shipped"));
 it("blocks shipment before QC",()=>expect(()=>appendManufacturingTransition({eventId:"e1",jobId:"j1",occurredAt:"x",from:"in-production",to:"shipped",actorId:"f",idempotencyKey:"k",metadata:{}})).toThrow());
});
