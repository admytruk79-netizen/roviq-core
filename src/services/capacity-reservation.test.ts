import { describe,expect,it } from 'vitest';
import { reserveCanonicalCapacity } from './capacity-reservation.js';

const futureWindow={
  id:'11111111-1111-1111-1111-111111111111',
  resource_id:null as string|null,
  capacity_units:2,
  capacity_state:'available',
  sync_state:'current',
  window_start:'2099-01-01T10:00:00.000Z',
  window_end:'2099-01-01T12:00:00.000Z',
  connection_status:'active'
};

function reservationDb(overrides:{resourceId?:string|null;resourceState?:'available'|'busy'|'blocked'|'offline';resourceActive?:boolean}={}){
  const queries:{sql:string;params:unknown[]}[]=[];
  const resourceId=overrides.resourceId??null;
  const window={...futureWindow,resource_id:resourceId};
  const db:any={query:async(sql:string,params:unknown[]=[] )=>{
    queries.push({sql,params});
    if(sql.includes('select resource_id from capacity_windows')) return {rowCount:1,rows:[{resource_id:resourceId}]};
    if(sql.includes('from service_resources')) return {rowCount:1,rows:[{id:resourceId,active:overrides.resourceActive??true,operational_state:overrides.resourceState??'available'}]};
    if(sql.includes('from capacity_windows cw')) return {rowCount:1,rows:[window]};
    if(sql.includes('select id,units from capacity_reservations')) return {rowCount:0,rows:[]};
    if(sql.includes('select coalesce(sum(units),0)::int as units')) return {rowCount:1,rows:[{units:0}]};
    return {rowCount:1,rows:[]};
  }};
  return {db,queries};
}

describe('canonical capacity reservation target time',()=>{
  it('rejects a future-only capacity window for an immediate request',async()=>{
    const {db}=reservationDb();
    await expect(reserveCanonicalCapacity(
      '22222222-2222-2222-2222-222222222222',
      futureWindow.id,
      db,
      1,
      new Date('2098-12-31T23:00:00.000Z')
    )).rejects.toThrow('capacity_no_longer_available');
  });

  it('reserves that same future window when the scheduled service target falls inside it',async()=>{
    const {db,queries}=reservationDb();
    await reserveCanonicalCapacity(
      '22222222-2222-2222-2222-222222222222',
      futureWindow.id,
      db,
      1,
      new Date('2099-01-01T10:30:00.000Z')
    );
    expect(queries.some(({sql})=>sql.includes('insert into capacity_reservations'))).toBe(true);
  });

  it('revalidates and locks a linked resource before locking and reserving its capacity window',async()=>{
    const {db,queries}=reservationDb({resourceId:'33333333-3333-3333-3333-333333333333'});
    await reserveCanonicalCapacity(
      '22222222-2222-2222-2222-222222222222',
      futureWindow.id,
      db,
      1,
      new Date('2099-01-01T10:30:00.000Z')
    );
    const resourceLock=queries.findIndex(({sql})=>sql.includes('from service_resources')&&sql.includes('for update'));
    const windowLock=queries.findIndex(({sql})=>sql.includes('from capacity_windows cw')&&sql.includes('for update'));
    expect(resourceLock).toBeGreaterThan(-1);
    expect(windowLock).toBeGreaterThan(resourceLock);
  });

  it('rejects reservation when the linked resource became blocked after evaluation',async()=>{
    const {db,queries}=reservationDb({resourceId:'33333333-3333-3333-3333-333333333333',resourceState:'blocked'});
    await expect(reserveCanonicalCapacity(
      '22222222-2222-2222-2222-222222222222',
      futureWindow.id,
      db,
      1,
      new Date('2099-01-01T10:30:00.000Z')
    )).rejects.toThrow('capacity_no_longer_available');
    expect(queries.some(({sql})=>sql.includes('insert into capacity_reservations'))).toBe(false);
  });
});
