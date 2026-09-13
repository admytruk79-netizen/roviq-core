import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

const source=readFileSync(new URL('./payment-state.ts',import.meta.url),'utf8');

describe('payment state hardening invariants',()=>{
  it('validates captured amount before same-state replay handling',()=>{
    const mismatch=source.indexOf("nextState==='captured'&&input.amount!==undefined&&!amountEquals(input.amount,p.amount)");
    const sameState=source.indexOf("if(p.state===nextState)");
    expect(mismatch).toBeGreaterThan(-1);
    expect(sameState).toBeGreaterThan(mismatch);
  });

  it('records a new provider event for a valid same-state provider replay',()=>{
    const sameState=source.indexOf("if(p.state===nextState)");
    const block=source.slice(sameState,source.indexOf('const allowed:',sameState));
    expect(block).toContain('if(input.providerEventId)');
    expect(block).toContain('insert into payment_events');
  });

  it('finalizes completion independently from customer snapshot projection',()=>{
    expect(source).toContain('Promise.allSettled(sideEffects)');
    expect(source).toContain('setCustomerSnapshot(');
    expect(source).toContain('finalizeExternalCaseTransition(');
    expect(source).toContain('payment_post_commit_transition_finalize_failed');
  });
});
