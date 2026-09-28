import { z } from 'zod';
import { pool } from '../db/pool.js';
import type { PoolClient } from 'pg';

type Queryable = Pick<PoolClient, 'query'>;
import type { RoviqRole } from '../types/principal.js';

// The vehicle on a Service Case lives in customer_vehicles, the same record Shop OS repair orders,
// deferred service and connected devices use. The customer supplies it at intake; the on-site
// diagnostic or shop confirms it. Every other actor sees only what its job needs (projectVehicle).

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;
const maxYear = () => new Date().getUTCFullYear() + 2;

export const vinSchema = z.string().trim().transform((v) => v.toUpperCase().replace(/[\s-]/g, ''))
  .refine((v) => VIN_RE.test(v), { message: 'VIN must be 17 letters and digits (no I, O or Q)' });

const optionalText = (max: number) => z.string().trim().min(1).max(max).optional();

const vehicleFields = {
  vin: vinSchema.optional(),
  year: z.number().int().min(1950).refine((y) => y <= maxYear(), { message: 'Year is in the future' }),
  make: z.string().trim().min(1).max(40),
  model: z.string().trim().min(1).max(60),
  trim: optionalText(60),
  nickname: optionalText(40),
  color: optionalText(30),
  licensePlate: z.string().trim().toUpperCase().min(1).max(12).optional(),
  plateRegion: z.string().trim().toUpperCase().min(2).max(3).optional(),
  drivetrain: z.enum(['fwd', 'rwd', 'awd', '4wd']).optional(),
  fuelType: z.enum(['gasoline', 'diesel', 'hybrid', 'plug_in_hybrid', 'electric', 'other']).optional(),
  engine: optionalText(60),
  odometerValue: z.number().int().nonnegative().max(2_000_000).optional(),
  odometerUnit: z.enum(['miles', 'kilometers']).optional()
};

/** A customer adding a vehicle: year, make and model are required, the rest help the network. */
export const newVehicleSchema = z.object(vehicleFields);
/** Any correction to an existing vehicle; only supplied fields change. */
export const vehicleUpdateSchema = z.object(vehicleFields).partial();
export type NewVehicle = z.infer<typeof newVehicleSchema>;
export type VehicleUpdate = z.infer<typeof vehicleUpdateSchema>;

export type VehicleRow = {
  id: string; customer_actor_id: string | null; vin: string | null; year: number | null; make: string | null;
  model: string | null; trim: string | null; nickname: string | null; color: string | null; license_plate: string | null;
  plate_region: string | null; drivetrain: string | null; fuel_type: string | null; engine: string | null;
  odometer_value: number | null; odometer_unit: string; verified_at: string | null; verified_by_actor_id: string | null;
  archived_at: string | null; created_at: string; updated_at: string;
};

const columnFor: Record<keyof VehicleUpdate, string> = {
  vin: 'vin', year: 'year', make: 'make', model: 'model', trim: 'trim', nickname: 'nickname', color: 'color',
  licensePlate: 'license_plate', plateRegion: 'plate_region', drivetrain: 'drivetrain', fuelType: 'fuel_type',
  engine: 'engine', odometerValue: 'odometer_value', odometerUnit: 'odometer_unit'
};

const IDENTIFYING = new Set<keyof VehicleUpdate>(['vin', 'year', 'make', 'model', 'trim', 'engine', 'drivetrain', 'fuelType']);

export class VehicleError extends Error {
  constructor(public code: string, public status: number) { super(code); }
}

function vinConflict(error: unknown): never {
  if ((error as { code?: string })?.code === '23505') throw new VehicleError('vehicle_vin_conflict', 409);
  throw error;
}

export async function listCustomerVehicles(customerActorId: string) {
  const r = await pool.query<VehicleRow>(
    `select * from customer_vehicles where customer_actor_id=$1 and archived_at is null order by updated_at desc`,
    [customerActorId]
  );
  return r.rows;
}

export async function createCustomerVehicle(customerActorId: string, input: NewVehicle, db: Queryable = pool) {
  const entries = Object.entries(input).filter(([, v]) => v !== undefined) as [keyof VehicleUpdate, unknown][];
  const columns = ['customer_actor_id', ...entries.map(([k]) => columnFor[k])];
  const values = [customerActorId, ...entries.map(([, v]) => v)];
  try {
    const r = await db.query<VehicleRow>(
      `insert into customer_vehicles(${columns.join(',')}) values(${columns.map((_, i) => `$${i + 1}`).join(',')}) returning *`,
      values
    );
    return r.rows[0];
  } catch (error) { return vinConflict(error); }
}

/** Update a vehicle. `verify` records an on-site confirmation by `verifiedBy` (null for admin). */
export async function updateVehicle(vehicleId: string, input: VehicleUpdate, db: Queryable = pool, verification?: { verifiedBy: string | null }) {
  const entries = Object.entries(input).filter(([, v]) => v !== undefined) as [keyof VehicleUpdate, unknown][];
  const sets = entries.map(([k], i) => `${columnFor[k]}=$${i + 2}`);
  const values: unknown[] = [vehicleId, ...entries.map(([, v]) => v)];
  if (verification) {
    values.push(verification.verifiedBy);
    sets.push(`verified_at=now()`, `verified_by_actor_id=$${values.length}`);
  } else if (entries.some(([k]) => IDENTIFYING.has(k))) {
    // A customer edit to what identifies the vehicle means the on-site confirmation no longer holds.
    sets.push(`verified_at=null`, `verified_by_actor_id=null`);
  }
  sets.push('updated_at=now()');
  try {
    const r = await db.query<VehicleRow>(`update customer_vehicles set ${sets.join(',')} where id=$1 returning *`, values);
    if (!r.rowCount) throw new VehicleError('vehicle_not_found', 404);
    return r.rows[0];
  } catch (error) { if (error instanceof VehicleError) throw error; return vinConflict(error); }
}

/** The customer's own active vehicle, or a 404 -- never another customer's. */
export async function loadOwnedVehicle(customerActorId: string, vehicleId: string, db: Queryable = pool) {
  const r = await db.query<VehicleRow>(
    `select * from customer_vehicles where id=$1 and customer_actor_id=$2 and archived_at is null`,
    [vehicleId, customerActorId]
  );
  if (!r.rowCount) throw new VehicleError('vehicle_not_found', 404);
  return r.rows[0];
}

export async function loadCaseVehicle(caseId: string, db: Queryable = pool) {
  const r = await db.query<VehicleRow>(
    `select v.* from service_cases c join customer_vehicles v on v.id=c.vehicle_id where c.id=$1`,
    [caseId]
  );
  return r.rows[0] ?? null;
}

type Projection = Record<string, unknown> & { id: string; verified: boolean };

/**
 * What each role may see of the case vehicle, mirroring the spatial projection: the customer,
 * shop, diagnostic and admin see the full record; tow sees what it needs to find and load the
 * vehicle (no VIN or odometer); parts sees what it needs for fitment (no plate, color or
 * odometer); mobility, which supplies a loaner rather than touching this vehicle, sees nothing.
 */
export function projectVehicle(role: RoviqRole, v: VehicleRow | null): Projection | null {
  if (!v) return null;
  const base = { id: v.id, verified: v.verified_at !== null, year: v.year, make: v.make, model: v.model, trim: v.trim };
  const full = {
    ...base, vin: v.vin, nickname: v.nickname, color: v.color, licensePlate: v.license_plate, plateRegion: v.plate_region,
    drivetrain: v.drivetrain, fuelType: v.fuel_type, engine: v.engine, odometerValue: v.odometer_value,
    odometerUnit: v.odometer_unit, verifiedAt: v.verified_at
  };
  switch (role) {
    case 'admin': case 'customer': case 'partner': case 'diagnostic':
      return full;
    case 'tow':
      return { ...base, color: v.color, licensePlate: v.license_plate, plateRegion: v.plate_region, drivetrain: v.drivetrain, fuelType: v.fuel_type };
    case 'parts':
      return { ...base, vin: v.vin, engine: v.engine, drivetrain: v.drivetrain, fuelType: v.fuel_type };
    default:
      return null;
  }
}

export function vehicleForCustomer(v: VehicleRow) {
  return projectVehicle('customer', v)!;
}
