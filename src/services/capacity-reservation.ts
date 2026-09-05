import type { PoolClient } from 'pg';

type Queryable = Pick<PoolClient,'query'>;

/**
 * Reserve one canonical capacity unit for a case inside the caller's transaction.
 * The capacity-window row is locked so concurrent selections serialize on the
 * same authoritative inventory record.
 */
export async function reserveCanonicalCapacity(
  caseId:string,
  capacityWindowId:string,
  db:Queryable,
  units=1
):Promise<void>{
  const window=await db.query(
    `select id,capacity_units,window_end
       from capacity_windows
      where id=$1
      for update`,
    [capacityWindowId]
  );
  if(!window.rowCount) throw new Error('capacity_window_not_found');

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
  const total=Number(window.rows[0].capacity_units ?? 0);
  const heldUnits=Number(held.rows[0]?.units ?? 0);
  if(!Number.isFinite(total)||!Number.isFinite(heldUnits)||total-heldUnits<units){
    throw new Error('capacity_no_longer_available');
  }

  await db.query(
    `insert into capacity_reservations(service_case_id,capacity_window_id,units,state,expires_at)
     values($1,$2,$3,'held',least($4::timestamptz,now()+interval '30 minutes'))`,
    [caseId,capacityWindowId,units,window.rows[0].window_end]
  );
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
