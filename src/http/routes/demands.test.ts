import { describe,expect,it } from 'vitest';
import { createDemandSchema } from './demand-schema.js';

describe('maintenance demand schedule validation',()=>{
  it('accepts the legacy attributes timestamp only after validating and canonicalizing it',()=>{
    const parsed=createDemandSchema.parse({
      demandType:'repair',
      attributes:{requestedServiceAt:'2026-09-12T17:30:00.000Z',note:'legacy-client'}
    });
    expect(parsed.requestedServiceAt).toBe('2026-09-12T17:30:00.000Z');
    expect(parsed.attributes).toEqual({note:'legacy-client'});
  });

  it('rejects a malformed legacy attributes timestamp instead of falling back to immediate service',()=>{
    expect(()=>createDemandSchema.parse({
      demandType:'repair',
      attributes:{requestedServiceAt:'tomorrow afternoon'}
    })).toThrow();
  });

  it('rejects conflicting top-level and legacy timestamps',()=>{
    expect(()=>createDemandSchema.parse({
      demandType:'repair',
      requestedServiceAt:'2026-09-12T17:30:00.000Z',
      attributes:{requestedServiceAt:'2026-09-13T17:30:00.000Z'}
    })).toThrow();
  });

  it('uses the top-level timestamp as the single persisted source when both paths agree',()=>{
    const parsed=createDemandSchema.parse({
      demandType:'repair',
      requestedServiceAt:'2026-09-12T17:30:00.000Z',
      attributes:{requestedServiceAt:'2026-09-12T17:30:00.000Z'}
    });
    expect(parsed.requestedServiceAt).toBe('2026-09-12T17:30:00.000Z');
    expect(parsed.attributes).not.toHaveProperty('requestedServiceAt');
  });
});
