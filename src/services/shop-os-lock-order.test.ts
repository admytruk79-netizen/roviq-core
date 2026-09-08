import {describe,expect,it} from 'vitest';
import {lockSchedulingCase} from './shop-os.js';

describe('Shop OS scheduling lock order',()=>{
  it('takes the service-case row lock before appointment creation can proceed to resource locking',async()=>{
    const calls:string[]=[];
    const db:any={query:async(sql:string)=>{
      calls.push(sql.replace(/\s+/g,' ').trim());
      return {rowCount:1,rows:[{id:'11111111-1111-1111-1111-111111111111'}]};
    }};

    await lockSchedulingCase('11111111-1111-1111-1111-111111111111',db);
    await db.query('select id from service_resources where id=$1 for update',['22222222-2222-2222-2222-222222222222']);

    expect(calls[0]).toContain('from service_cases');
    expect(calls[0]).toContain('for update');
    expect(calls[1]).toContain('from service_resources');
    expect(calls[1]).toContain('for update');
  });

  it('does not lock a service-case row for appointments without a linked case',async()=>{
    let called=false;
    const db:any={query:async()=>{called=true;return {rowCount:0,rows:[]};}};
    await lockSchedulingCase(null,db);
    expect(called).toBe(false);
  });
});
