import type { PoolClient } from 'pg';
import type { Principal } from '../types/principal.js';
import { loadActorQualifications } from './serviceability-gate.js';
import { appendCaseEvent } from './case-events.js';

/** Must run inside the same transaction AFTER updating credential evidence.
 * Caller holds the affected actor row lock (also used by provider assignment).
 * This is a safety hold, not an automated cancellation of work in progress.
 */
export async function reassessCredentialImpact(
  client: PoolClient, principal: Principal,
  actorId: string, requirementKey: string, kind: string
) {
  const cases = await client.query(
    `select sc.id,sc.demand_id,sc.state,sc.selected_actor_id,sc.recommended_actor_id
       from service_cases sc
       join case_qualification_requirements qr on qr.service_case_id=sc.id
      where qr.requirement_key=$2 and qr.kind=$3
        and sc.state not in ('completed','cancelled')
        and (sc.selected_actor_id=$1 or sc.recommended_actor_id=$1
             or exists(select 1 from matches_offers mo
                        where mo.case_id=sc.id and mo.actor_id=$1 and mo.outcome='offered'))
      order by sc.id for update of sc`,
    [actorId, requirementKey, kind]
  );
  const impacted: Array<{caseId:string;outcome:string}> = [];
  for (const row of cases.rows) {
    const qualification = await loadActorQualifications(row.id, actorId, client, new Date());
    // An alternate valid evidence record may preserve eligibility.
    if (qualification.decision === 'eligible') continue;
    const offers = await client.query(
      `update matches_offers set outcome='declined',responded_at=coalesce(responded_at,now())
        where case_id=$1 and actor_id=$2 and outcome='offered' returning id`,
      [row.id,actorId]
    );
    if (row.recommended_actor_id === actorId) {
      await client.query(
        'update service_cases set recommended_actor_id=null,updated_at=now() where id=$1',
        [row.id]
      );
    }
    if (row.demand_id && row.selected_actor_id !== actorId) {
      await client.query(
        `insert into routing_decisions(demand_id,eligible_actor_ids,rejected_candidates,ranking_trace,
          selected_actor_id,recommended_actor_id,selection_mode,decision_basis)
         select $1,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,null,null,coalesce(selection_mode,'customer_choice'),
          'qualification_revoked:reroute_required'
         from service_cases where id=$2`,
        [row.demand_id,row.id]
      );
    }
    // Reopen recovery when a later review independently makes work infeasible.
    await client.query(
      `insert into qualification_recovery_cases(case_id,actor_id,requirement_key,state)
       values($1,$2,$3,'open')
       on conflict(case_id,actor_id,requirement_key)
       do update set state='open',resolution_type=null,resolution_note=null,
         evidence_reference=null,resolved_by_identity_id=null,resolved_at=null,updated_at=now()`,
      [row.id,actorId,requirementKey]
    );
    const selected = row.selected_actor_id === actorId;
    const reason = selected ? 'assigned_provider_qualification_review' : 'provider_qualification_reroute_required';
    // Prevent duplicate unresolved exceptions for repeated credential reviews.
    await client.query(
      `insert into case_exceptions(case_id,exception_code,severity,summary,metadata)
       select $1,'PROVIDER_QUALIFICATION_REVIEW', 'warning',
         'Provider qualification requires operational review.',
         $2::jsonb
       where not exists(
         select 1 from case_exceptions where case_id=$1
           and exception_code='PROVIDER_QUALIFICATION_REVIEW'
       )`,
      [row.id,JSON.stringify({actorId,requirementKey,reason})]
    );
    // Internal push outbox records only. External push delivery depends on configured
    // channels and a subscribed recipient; no contact details are copied to payload.
    // Unique index prevents repeated credential reviews from spamming a case.
    const recipients = await client.query(
      `select distinct recipient_id from (
         select sc.customer_actor_id as recipient_id from service_cases sc where sc.id=$1
         union all select $2::uuid as recipient_id
       ) recipients where recipient_id is not null`,
      [row.id,actorId]
    );
    for(const recipient of recipients.rows){
      await client.query(
        `insert into notification_outbox(case_id,channel,recipient_type,recipient_id,template_key,payload)
         values($1,'push','actor',$2,'provider_qualification_disruption',$3::jsonb)
         on conflict(case_id,recipient_id,template_key)
           where template_key='provider_qualification_disruption' and case_id is not null
         do nothing`,
        [row.id,recipient.recipient_id,JSON.stringify({caseId:row.id,kind:'service_review_required'})]
      );
    }
    await appendCaseEvent(row.id,'PROVIDER_QUALIFICATION_CHANGED',principal,{
      actorId,requirementKey,reason,selected,withdrawnOfferIds:offers.rows.map((o:any)=>o.id)
    },client);
    impacted.push({caseId:row.id,outcome:reason});
  }
  return impacted;
}
