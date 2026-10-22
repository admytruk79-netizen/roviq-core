-- Explicit rollout: new business onboarding is enforced; legacy organizations must be enrolled
-- after their credentials are reviewed. No fabricated credentials or destructive job cancellation.
create table business_service_policies (
  organization_id uuid primary key references organizations(id),
  enrolled_at timestamptz not null default now()
);
create table business_service_authorizations (
  organization_id uuid not null references business_service_policies(organization_id),
  service text not null check(service in ('repair','diagnostic','tow','valet','parts','mobility')),
  state text not null check(state in ('pending','verified','suspended','revoked')),
  valid_from timestamptz not null default now(),
  expires_at timestamptz,
  evidence_reference text,
  verified_by_identity_id uuid references principal_identities(id),
  verified_at timestamptz,
  review_reason text not null,
  updated_at timestamptz not null default now(),
  primary key(organization_id,service),
  check(expires_at is null or expires_at>valid_from),
  check(state<>'verified' or (expires_at is not null and evidence_reference is not null and verified_at is not null))
);
insert into business_service_policies(organization_id)
select distinct organization_id from actors
where attributes->>'onboardingSource'='ops_business_onboarding' and organization_id is not null;

create function actor_service_eligible(p_actor uuid,p_service text) returns boolean
language sql volatile as $$
 select coalesce((select a.status='active' and (a.organization_id is null or o.status='active') and
   (p.organization_id is null or exists(
     select 1 from business_service_authorizations c
     where c.organization_id=a.organization_id and c.service=p_service and c.state='verified'
       and c.valid_from<=clock_timestamp() and c.expires_at>clock_timestamp()))
   from actors a left join organizations o on o.id=a.organization_id
   left join business_service_policies p on p.organization_id=a.organization_id
   where a.id=p_actor),false)
$$;

create function assert_actor_service_eligible(p_actor uuid,p_service text) returns void
language plpgsql as $$
declare org uuid;
begin
  -- Serialize assignment with actor suspension and credential enrollment/review. Credential writers
  -- lock this same organization first. Use the wall clock: a long transaction cannot extend expiry.
  select organization_id into org from actors where id=p_actor for share;
  if org is not null then perform 1 from organizations where id=org for share; end if;
  if not actor_service_eligible(p_actor,p_service) then
    raise exception using errcode='P0001',message='service_credential_ineligible',detail=p_service;
  end if;
end $$;

alter table matches_offers add column required_service text check(required_service in ('repair','diagnostic'));
create function check_offer_service_eligibility() returns trigger language plpgsql as $$
begin
  if TG_OP='UPDATE' and old.required_service is not null and new.required_service is distinct from old.required_service then
    raise exception 'offer_required_service_immutable';
  end if;
  if TG_OP='INSERT' or new.required_service is null then
    new.required_service := case when exists(select 1 from service_cases where id=new.case_id and state in ('diagnostic_pending','diagnostic_in_progress'))
      or exists(select 1 from actors where id=new.actor_id and actor_type='diagnostic') then 'diagnostic' else 'repair' end;
  end if;
  if new.outcome in ('offered','accepted') and
    (TG_OP='INSERT' or new.actor_id is distinct from old.actor_id or new.outcome is distinct from old.outcome) then
    perform assert_actor_service_eligible(new.actor_id,new.required_service);
  end if;
  return new;
end $$;
create trigger offer_service_eligibility before insert or update on matches_offers for each row execute function check_offer_service_eligibility();

create function check_job_service_eligibility() returns trigger language plpgsql as $$
declare actor uuid; previous_actor uuid; needs_check boolean; required text;
begin
  if TG_TABLE_NAME='transport_dispatches' then
    actor:=new.provider_actor_id; required:=new.transport_type;
    if TG_OP='UPDATE' then previous_actor:=old.provider_actor_id; end if;
    needs_check:=TG_OP='INSERT' or actor is distinct from previous_actor;
    if TG_OP='UPDATE' then needs_check:=needs_check or (new.status in ('assigned','accepted') and new.status is distinct from old.status)
      or new.transport_type is distinct from old.transport_type; end if;
  elsif TG_TABLE_NAME='mobility_allocations' then
    actor:=new.provider_actor_id; required:='mobility';
    if TG_OP='UPDATE' then previous_actor:=old.provider_actor_id; end if;
    needs_check:=TG_OP='INSERT' or actor is distinct from previous_actor;
    if TG_OP='UPDATE' then needs_check:=needs_check or (new.state in ('assigned','active') and new.state is distinct from old.state); end if;
  elsif TG_TABLE_NAME='parts_orders' then
    actor:=new.supplier_actor_id; required:='parts';
    if TG_OP='UPDATE' then previous_actor:=old.supplier_actor_id; end if;
    needs_check:=TG_OP='INSERT' or actor is distinct from previous_actor;
    if TG_OP='UPDATE' then needs_check:=needs_check or (new.status in ('supplier_assigned','reserved','ordered') and new.status is distinct from old.status); end if;
  elsif TG_TABLE_NAME='service_cases' then
    actor:=new.selected_actor_id; required:='repair';
    if TG_OP='UPDATE' then previous_actor:=old.selected_actor_id; end if;
    needs_check:=TG_OP='INSERT' or actor is distinct from previous_actor;
  elsif TG_TABLE_NAME='network_handoffs' then
    actor:=new.participant_actor_id;
    required:=case new.handoff_type when 'service_provider' then 'repair' when 'transport' then 'tow' else new.handoff_type end;
    if new.handoff_type='transport' and new.reference_type='transport_dispatch' then
      select transport_type into required from transport_dispatches where id::text=new.reference_id;
    end if;
    if TG_OP='UPDATE' then previous_actor:=old.participant_actor_id; end if;
    needs_check:=TG_OP='INSERT' or actor is distinct from previous_actor;
    if TG_OP='UPDATE' then needs_check:=needs_check or (new.status in ('assigned','accepted') and new.status is distinct from old.status)
      or new.handoff_type is distinct from old.handoff_type; end if;
    -- 'other' handoffs are coordination annotations, not a service capability.
    needs_check:=needs_check and new.handoff_type<>'other';
  end if;
  if actor is not null and needs_check then perform assert_actor_service_eligible(actor,required); end if;
  return new;
end $$;
create trigger transport_service_eligibility before insert or update on transport_dispatches for each row execute function check_job_service_eligibility();
create trigger mobility_service_eligibility before insert or update on mobility_allocations for each row execute function check_job_service_eligibility();
create trigger parts_service_eligibility before insert or update on parts_orders for each row execute function check_job_service_eligibility();
create trigger selected_shop_service_eligibility before insert or update on service_cases for each row execute function check_job_service_eligibility();
create trigger handoff_service_eligibility before insert or update on network_handoffs for each row execute function check_job_service_eligibility();

create view business_service_work as
select m.case_id,m.actor_id,coalesce(m.required_service,case when a.actor_type='diagnostic' then 'diagnostic' else 'repair' end) as service,
 'offer'::text as reference_type,m.id as reference_id,m.outcome as status
 from matches_offers m join actors a on a.id=m.actor_id where m.outcome in ('offered','accepted')
 union all select case_id,provider_actor_id,transport_type,'transport',id,status from transport_dispatches
 where provider_actor_id is not null and status not in ('delivered','declined','cancelled','failed')
 union all select case_id,supplier_actor_id,'parts','parts_order',id,status from parts_orders
 where supplier_actor_id is not null and status not in ('delivered','cancelled','failed')
 union all select case_id,provider_actor_id,'mobility','mobility_allocation',id,state from mobility_allocations
 where provider_actor_id is not null and state not in ('completed','declined','cancelled','failed');
