import { pool } from '../db/pool.js';

function objectLocation(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  return Object.keys(object).length ? object : undefined;
}

/**
 * Resolve transport locations from the canonical Service Case spatial projection.
 * Explicit dispatch locations win. If they are absent, use the vehicle/origin and
 * destination already attached to the case. As a final pickup fallback, use the
 * originating demand location so a valid customer intake point cannot disappear
 * between intake and Tow / Valet assignment.
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
  const pickupLocation = objectLocation(input.pickupLocation)
    ?? objectLocation(current.current_vehicle)
    ?? objectLocation(current.origin)
    ?? objectLocation(current.demand_location);
  const dropoffLocation = objectLocation(input.dropoffLocation)
    ?? objectLocation(current.destination);

  return {
    pickupLocation,
    dropoffLocation,
    locationStatus: pickupLocation ? (dropoffLocation ? 'ready' : 'pickup_ready') : 'location_pending'
  } as const;
}
