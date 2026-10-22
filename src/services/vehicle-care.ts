import { z } from 'zod';
import { pool } from '../db/pool.js';
import { loadOwnedVehicle, VehicleError } from './case-vehicle.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
  const parsed = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === v;
}, 'Use a valid calendar date');
export const reminderSchema = z.object({
  id: z.string().uuid(), title: z.string().trim().min(1).max(120),
  dueDate: date.optional(), dueOdometer: z.number().int().min(0).max(2_000_000).optional(),
  odometerUnit: z.enum(['miles', 'kilometers']).default('miles')
}).refine(v => v.dueDate !== undefined || v.dueOdometer !== undefined, 'Choose a date or odometer threshold');

export async function loadVehicleCare(actorId: string, vehicleId: string) {
  const vehicle = await loadOwnedVehicle(actorId, vehicleId);
  const [history, reminders] = await Promise.all([
    pool.query(`select id,value,unit,source,recorded_at as "recordedAt" from vehicle_odometer_history
      where vehicle_id=$1 order by id desc limit 50`, [vehicleId]),
    pool.query(`select id,title,to_char(due_date,'YYYY-MM-DD') as "dueDate",due_odometer as "dueOdometer",
      odometer_unit as "odometerUnit",completed_at as "completedAt",
      completed_at is null and (
        due_date <= (now() at time zone 'UTC')::date or
        due_odometer::numeric * case odometer_unit when 'miles' then 1.609344 else 1 end <=
        $2::numeric * case $3::text when 'miles' then 1.609344 else 1 end
      ) is true as due
      from vehicle_service_reminders where vehicle_id=$1 order by (completed_at is not null),created_at desc limit 100`,
    [vehicleId, vehicle.odometer_value, vehicle.odometer_unit])
  ]);
  return { history: history.rows, reminders: reminders.rows };
}

export async function createServiceReminder(actorId: string, vehicleId: string, input: z.infer<typeof reminderSchema>) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await loadOwnedVehicle(actorId, vehicleId, client);
    // Serialize the limit and retry lookup for this vehicle. The client UUID makes retries safe.
    await client.query('select id from customer_vehicles where id=$1 for update', [vehicleId]);
    const existing = await client.query(`select id,title,to_char(due_date,'YYYY-MM-DD') as due_date,
      due_odometer,odometer_unit from vehicle_service_reminders where id=$1 and vehicle_id=$2`, [input.id, vehicleId]);
    if (existing.rowCount) {
      const row = existing.rows[0];
      if (row.title !== input.title || row.due_date !== (input.dueDate ?? null) ||
          row.due_odometer !== (input.dueOdometer ?? null) || row.odometer_unit !== input.odometerUnit) {
        throw new VehicleError('reminder_retry_conflict', 409);
      }
    } else {
      const count = await client.query(`select count(*)::int as n from vehicle_service_reminders
        where vehicle_id=$1 and completed_at is null`, [vehicleId]);
      if (count.rows[0].n >= 100) throw new VehicleError('reminder_limit_reached', 409);
      const inserted = await client.query(`insert into vehicle_service_reminders
        (id,vehicle_id,title,due_date,due_odometer,odometer_unit) values($1,$2,$3,$4,$5,$6)
        on conflict(id) do nothing returning id`,
      [input.id, vehicleId, input.title, input.dueDate ?? null, input.dueOdometer ?? null, input.odometerUnit]);
      if (!inserted.rowCount) throw new VehicleError('reminder_retry_conflict', 409);
    }
    await client.query('commit');
    return { id: input.id };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally { client.release(); }
}

export async function completeServiceReminder(actorId: string, vehicleId: string, reminderId: string) {
  await loadOwnedVehicle(actorId, vehicleId);
  const result = await pool.query(`update vehicle_service_reminders set completed_at=coalesce(completed_at,now())
    where id=$1 and vehicle_id=$2 returning id`, [reminderId, vehicleId]);
  if (!result.rowCount) throw new VehicleError('reminder_not_found', 404);
  return { completed: true };
}
