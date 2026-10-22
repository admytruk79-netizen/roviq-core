-- Repair starts can originate without a new network offer (roadside upgrade or local walk-in).
create function organization_service_eligible(p_org uuid,p_service text) returns boolean language sql volatile as $$
 select coalesce((select o.status='active' and (p.organization_id is null or exists(
   select 1 from business_service_authorizations c where c.organization_id=o.id and c.service=p_service
     and c.state='verified' and c.valid_from<=clock_timestamp() and c.expires_at>clock_timestamp()))
   from organizations o left join business_service_policies p on p.organization_id=o.id where o.id=p_org),false)
$$;
create function check_repair_start_eligibility() returns trigger language plpgsql as $$
declare operator uuid; needs_check boolean;
begin
  if TG_TABLE_NAME='shop_repair_orders' then
    needs_check:=new.status in ('approved','in_progress');
    if TG_OP='UPDATE' then needs_check:=(needs_check and new.status is distinct from old.status and old.started_at is null)
      or new.organization_id is distinct from old.organization_id; end if;
    if needs_check then
      perform 1 from organizations where id=new.organization_id for share;
      if not organization_service_eligible(new.organization_id,'repair') then raise exception 'service_credential_ineligible'; end if;
    end if;
  elsif TG_TABLE_NAME='field_service_decisions' then
    needs_check:=new.action in ('field_repair','temporary_stabilization') and new.status in ('authorized','in_progress');
    if TG_OP='UPDATE' then needs_check:=needs_check and (new.status is distinct from old.status or new.action is distinct from old.action
      or new.operator_context is distinct from old.operator_context); end if;
    if needs_check then
      if new.operator_context->>'operatorActorId' is not null and not (new.operator_context->>'operatorActorId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then raise exception 'service_credential_ineligible'; end if;
      operator:=coalesce((new.operator_context->>'operatorActorId')::uuid,new.created_by_actor_id);
      perform assert_actor_service_eligible(operator,'repair');
    end if;
  end if;
  return new;
end $$;
create trigger shop_repair_start_eligibility before insert or update on shop_repair_orders for each row execute function check_repair_start_eligibility();
create trigger field_repair_start_eligibility before insert or update on field_service_decisions for each row execute function check_repair_start_eligibility();

create or replace view business_service_work as
select m.case_id,m.actor_id,coalesce(m.required_service,case when a.actor_type='diagnostic' then 'diagnostic' else 'repair' end) as service,
 'offer'::text as reference_type,m.id as reference_id,m.outcome as status,null::uuid as organization_id
 from matches_offers m join actors a on a.id=m.actor_id where m.outcome in ('offered','accepted')
 union all select case_id,provider_actor_id,transport_type,'transport',id,status,null::uuid from transport_dispatches
 where provider_actor_id is not null and status not in ('delivered','declined','cancelled','failed')
 union all select case_id,supplier_actor_id,'parts','parts_order',id,status,null::uuid from parts_orders
 where supplier_actor_id is not null and status not in ('delivered','cancelled','failed')
 union all select case_id,provider_actor_id,'mobility','mobility_allocation',id,state,null::uuid from mobility_allocations
 where provider_actor_id is not null and state not in ('completed','declined','cancelled','failed')
 union all select service_case_id,coalesce(primary_technician_actor_id,advisor_actor_id,created_by_actor_id),'repair','shop_repair_order',id,status,organization_id
 from shop_repair_orders where status in ('approved','in_progress','waiting_parts','waiting_customer','quality_control')
 union all select case_id,case when operator_context->>'operatorActorId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (operator_context->>'operatorActorId')::uuid else created_by_actor_id end,'repair','field_service_decision',id,status,null::uuid
 from field_service_decisions where action in ('field_repair','temporary_stabilization') and status in ('authorized','in_progress');
