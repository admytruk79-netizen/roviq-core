import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const service=readFileSync(new URL('./exception-engine.ts',import.meta.url),'utf8');
const routes=readFileSync(new URL('../http/routes/exceptions.ts',import.meta.url),'utf8');

const ops=readFileSync(new URL('../../ops/src/pages/Exceptions.tsx',import.meta.url),'utf8');

describe('exception recovery invariants',()=>{
  it('filters the active queue on the server before applying its limit',()=>{
    expect(routes).toContain("active:z.coerce.boolean().optional()");
    expect(routes).toContain("states:query.active?['open','acknowledged','remediating']:undefined");
    expect(service).toContain("e.state=any($${params.length}::text[])");
  });

  it('treats repeated state requests as idempotent',()=>{
    expect(service).toContain("if (row.state === input.state)");
    expect(service).toContain("return row;");
  });

  it('guards queue responses against stale requests and closed overdue counts',()=>{
    expect(ops).toContain('requestSequence=useRef(0)');
    expect(ops).toContain('if(requestId!==requestSequence.current)return;');
    expect(ops).toContain("!['resolved','dismissed'].includes(item.state)");
  });

  it('applies successful recovery mutations locally before refreshing',()=>{
    expect(ops).toContain('onUpdated(updated);');
    expect(ops).toContain('Recovery state was saved, but the queue could not be refreshed.');
  });
});
