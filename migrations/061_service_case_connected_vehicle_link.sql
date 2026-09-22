-- ROVIQ Core migration 061
-- Fixes a schema collision in migration 059: service_cases already had a vehicle_id column
-- (added by migration 016, referencing the older `vehicles` table used by the Service Plan/
-- commerce domain). Migration 059's `add column if not exists vehicle_id ... references
-- customer_vehicles(id)` silently no-op'd against that existing column, so the FK constraint in
-- place still points at `vehicles`, not `customer_vehicles` -- any attempt to link a service_case
-- to a connected-vehicle-domain vehicle fails with a foreign key violation. Migration 059 has
-- already shipped, so per this repo's own precedent (017, 020) it is not edited in place; this
-- adds a distinctly-named column instead and leaves the pre-existing vehicle_id/vehicles link
-- (and whatever already depends on it) untouched.

begin;

alter table service_cases add column if not exists connected_vehicle_id uuid references customer_vehicles(id) on delete set null;
create index if not exists idx_service_cases_connected_vehicle on service_cases(connected_vehicle_id, updated_at desc);

commit;
