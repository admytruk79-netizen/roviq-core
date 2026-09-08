import type { PoolClient } from 'pg';

type Queryable = Pick<PoolClient,'query'>;

async function resolveReservationTarget(caseId:string,db:Queryable,explicit?:Date):Promise<Date>{
  if(explicit) return explicit;
  const result=await db.query(`
    select coalesce(
      (
        select ra.starts_at::text
          from roviq_appointments ra
         where ra.service_case_id=sc.id
           and ra.appointment_status in ('held','confirmed','in_progress')
         order by ra.updated_at desc,ra.id desc
         limit 1
      ),
      nullif(sc.attributes->>'requestedServiceAt',''),
      nullif(dr.attributes->>'requestedServiceAt','')
    ) as service_target_at
    from service_cases sc
    left join demand_requests dr on dr.id=sc.demand_id
    where sc.id=$1`,[caseId]);
  const raw=result.rows[0]?.service_target_at;
  if(!raw) return new Date();
  const parsed=new Date(raw);
  return Number.isFinite(parsed.getTime())?parsed:new Date();
}

/**
 * Reserve one canonical capacity unit for a case inside the caller's transaction.
 * The capacity-window row is locked so concurrent selections serialize on the
 * same authoritative inventory record. serviceTargetAt is the requested service
 * instant; freshness and hold expiry still use the current clock.
 */
export async function reserveCanonicalCapacity(
  caseId:string,
  capacityWindowId:string,
  db:Queryable,
  units=1,
  serviceTargetAt?:Date
):Promise<void>{
  const targetAt=await resolveReservationTarget(caseId,db,serviceTargetAt);
  const window=await db.query(
    `select cw.id,cw.capacity_units,cw.capacity_state,cw.sync_state,cw.window_start,cw.window_end,
            psc.connection_status
       from capacity_windows cw
       left join partner_system_connections psc on psc.id=cw.source_connection_id
      where cw.id=$1
      for update of cw`,
    [capacityWindowId]
  );
  if(!window.rowCount) throw new Error('capacity_window_not_found');
  const row=window.rows[0];
  if(['blocked','unknown','full'].includes(row.capacity_state)) throw new Error('capacity_no_longer_available');
  if(!['current','manual'].includes(row.sync_state)) throw new Error('capacity_no_longer_available');
  if(row.connection_status&&row.connection_status!=='active') throw new Error('capacity_no_longer_available');
  const now=Date.now();
  const targetMs=targetAt.getTime();
  const startMs=new Date(row.window_start).getTime();
  const endMs=new Date(row.window_end).getTime();
  if(!Number.isFinite(targetMs)||!Number.isFinite(startMs)||!Number.isFinite(endMs)||startMs>targetMs||endMs<=targetMs){
    throw new Error('capacity_no_longer_available');
  }
  if(endMs<=now) throw new Error('capacity_no_longer_available');

  await db.query(
    `update capacity_reservations
        set state='expired',updated_at=now()
      where capacity_window_id=$1 and state='held' and expires_at<=now()`,
    [capacityWindowId]
  );

  const existing=await db.query(
    `select id,units from capacity_reservations
      where service_case_id=$1 and capacity_window_id=$2 and state='held' and expires_at>now()
      limit 1`,
    [caseId,capacityWindowId]
  );
  if(existing.rowCount) return;

  const held=await db.query(
    `select coalesce(sum(units),0)::int as units
       from capacity_reservations
      where capacity_window_id=$1 and state='held' and expires_at>now()`,
    [capacityWindowId]
  );
  const total=Number(row.capacity_units ?? 0);
  const heldUnits=Number(held.rows[0]?.units ?? 0);
  if(!Number.isFinite(total)||!Number.isFinite(heldUnits)||total-heldUnits<units){
    throw new Error('capacity_no_longer_available');
  }

  await db.query(
    `insert into capacity_reservations(service_case_id,capacity_window_id,units,state,expires_at)
     values($1,$2,$3,'held',least($4::timestamptz,now()+interval '30 minutes'))`,
    [caseId,capacityWindowId,units,row.window_end]
  );
}

export async function confirmCaseCapacity(caseId:string,db:Queryable):Promise<void>{
  await db.query(`
    update capacity_reservations cr
       set expires_at=cw.window_end,updated_at=now()
      from capacity_windows cw
     where cr.capacity_window_id=cw.id
       and cr.service_case_id=$1
       and cr.state='held'
       and cr.expires_at>now()
       and cw.window_end>now()`,[caseId]);
}

export async function releaseCaseCapacity(caseId:string,db:Queryable):Promise<void>{
  await db.query(
    `update capacity_reservations
        set state='released',released_at=now(),updated_at=now()
      where service_case_id=$1 and state='held'`,
    [caseId]
  );
}

export async function consumeCaseCapacity(caseId:string,db:Queryable):Promise<void>{
  await db.query(
    `update capacity_reservations
        set state='consumed',consumed_at=now(),updated_at=now()
      where service_case_id=$1 and state='held'`,
    [caseId]
  );
}
