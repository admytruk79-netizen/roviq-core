-- Production routing policy bootstrap for the Maintenance domain.
-- This migration is idempotent: it updates version 1 in place if it already exists
-- and ensures exactly one active row per policy key.

with maintenance_domain as (
  select id from domains where code = 'maintenance' limit 1
)
update routing_policies rp
set active = false,
    updated_at = now()
from maintenance_domain d
where rp.domain_id = d.id
  and rp.policy_key in ('maintenance_default', 'parts_supplier_default')
  and rp.active = true;

with maintenance_domain as (
  select id from domains where code = 'maintenance' limit 1
)
insert into routing_policies(domain_id, policy_key, version, active, configuration)
select
  d.id,
  'maintenance_default',
  1,
  true,
  '{
    "weights": {
      "rating": 1,
      "onTime": 3,
      "capacity": 0.2,
      "etaMinutes": -0.05,
      "distanceMiles": -0.1
    },
    "defaults": {
      "rating": 3,
      "onTime": 0.75,
      "capacity": 0
    },
    "limits": {
      "maxCandidates": 5
    }
  }'::jsonb
from maintenance_domain d
on conflict(domain_id, policy_key, version)
do update set
  active = excluded.active,
  configuration = excluded.configuration,
  updated_at = now();

with maintenance_domain as (
  select id from domains where code = 'maintenance' limit 1
)
insert into routing_policies(domain_id, policy_key, version, active, configuration)
select
  d.id,
  'parts_supplier_default',
  1,
  true,
  '{
    "weights": {
      "price": -0.02,
      "rating": 1,
      "onTime": 2,
      "capacity": 0.3
    },
    "defaults": {
      "rating": 3,
      "onTime": 0.75,
      "capacity": 0
    }
  }'::jsonb
from maintenance_domain d
on conflict(domain_id, policy_key, version)
do update set
  active = excluded.active,
  configuration = excluded.configuration,
  updated_at = now();
