import { pool } from '../db/pool.js';

function objectLocation(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  return Object.keys(object).length ? object : undefined;
}

/**
 * Resolve transport locations from the canonical Service Case spatial projection.
 * Explicit dispatch locations win. If they are absent, use the vehicle/origin and
 * destination already attached to the case. Return provenance as well so later
 * canonical destination corrections can update only dispatches that inherited
 * their destination from the Service Case, never a deliberate per-dispatch override.
 */
export async function resolveTransportLocations(
  caseId: string,
  input: { pickupLocation?: Record<string, unknown>; dropoffLocation?: Record<string, unknown> }
) {
  const row = await pool.query(
    `select c.id,c.demand_id,
            s.origin,s.current_vehicle,s.destination,
            d.location as demand_location
       from service_cases c
       left join case_spatial_context s on s.case_id=c.id
       left join demand_requests d on d.id=c.demand_id
      where c.id=$1`,
    [caseId]
  );
  if (!row.rowCount) throw new Error('case_not_found');

  const current = row.rows[0];
  const explicitPickup = objectLocation(input.pickupLocation);
  const currentVehicle = objectLocation(current.current_vehicle);
  const origin = objectLocation(current.origin);
  const demandLocation = objectLocation(current.demand_location);
  const explicitDropoff = objectLocation(input.dropoffLocation);
  const canonicalDestination = objectLocation(current.destination);

  const pickupLocation = explicitPickup ?? currentVehicle ?? origin ?? demandLocation;
  const dropoffLocation = explicitDropoff ?? canonicalDestination;
  const pickupSource = explicitPickup ? 'explicit_dispatch'
    : currentVehicle ? 'case_current_vehicle'
    : origin ? 'case_origin'
    : demandLocation ? 'demand_intake'
    : 'missing';
  const dropoffSource = explicitDropoff ? 'explicit_dispatch'
    : canonicalDestination ? 'case_spatial'
    : 'missing';

  return {
    pickupLocation,
    dropoffLocation,
    pickupSource,
    dropoffSource,
    locationStatus: pickupLocation ? (dropoffLocation ? 'ready' : 'pickup_ready') : 'location_pending'
  } as const;
}
