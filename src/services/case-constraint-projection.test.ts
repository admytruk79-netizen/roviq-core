import { describe, expect, it } from 'vitest';
import { deriveMobilityConstraint, derivePartsConstraint } from './case-constraint-projection.js';

describe('operational constraint projection',()=>{
  it('requires the explicit ready state for every required part',()=>{
    expect(derivePartsConstraint({received:1})).toMatchObject({status:'required',total:1,ready:0});
    expect(derivePartsConstraint({ready:1})).toMatchObject({status:'satisfied',total:1,ready:1});
    expect(derivePartsConstraint({ready:1,received:1})).toMatchObject({status:'required',total:2,ready:1});
  });

  it('keeps unavailable parts blocking even when other parts are ready',()=>{
    expect(derivePartsConstraint({ready:2,unavailable:1}).status).toBe('blocked');
  });

  it('lets the newest successful mobility replacement supersede historical failures',()=>{
    const result=deriveMobilityConstraint(['reserved','failed','declined']);
    expect(result.status).toBe('satisfied');
    expect(result.currentState).toBe('reserved');
    expect(result.history).toEqual({reserved:1,failed:1,declined:1});
  });

  it('blocks when the current mobility attempt failed but retains prior success for audit',()=>{
    const result=deriveMobilityConstraint(['failed','completed']);
    expect(result.status).toBe('blocked');
    expect(result.currentState).toBe('failed');
    expect(result.history).toEqual({failed:1,completed:1});
  });
});
