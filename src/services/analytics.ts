import { pool } from '../db/pool.js';

export type CaseMetricsRange = { from?:string; to?:string };

// Each metric's exact definition is a product/reporting decision as much as a query -- stated
// here explicitly so it's auditable and easy to correct if the intended definition differs,
// rather than left implicit in SQL.
export async function getCaseMetrics(range:CaseMetricsRange = {}) {
  const from = range.from ?? null;
  const to = range.to ?? null;

  const [
    caseDuration,
    diagnosticConversion,
    fieldRepairEligibility,
    fieldRepairSuccess,
    towAvoidance,
    handoffFailure,
    exceptionRate,
    customerResponseTime,
    contributionMargin
  ] = await Promise.all([
    // Average and median minutes from case creation to completion, for cases actually completed
    // in the window (filtered on completed_at, not created_at, so a case isn't counted before it
    // has a duration to report).
    pool.query(
      `select
         avg(extract(epoch from (completed_at-created_at))/60) as avg_minutes,
         percentile_cont(0.5) within group (order by extract(epoch from (completed_at-created_at))/60) as median_minutes,
         count(*) as sample_size
       from service_cases
       where state='completed' and completed_at is not null
         and ($1::timestamptz is null or completed_at>=$1) and ($2::timestamptz is null or completed_at<=$2)`,
      [from,to]
    ),
    // Share of diagnostic visits that convert into actual servicing: the finding's disposition
    // called for more than a look (not 'diagnose_only') and the case didn't end up cancelled.
    pool.query(
      `select
         count(*) filter (where df.disposition<>'diagnose_only' and coalesce(sc.state,'')<>'cancelled') as converted,
         count(*) as total
       from diagnostic_findings df
       left join service_cases sc on sc.id=df.case_id
       where ($1::timestamptz is null or df.created_at>=$1) and ($2::timestamptz is null or df.created_at<=$2)`,
      [from,to]
    ),
    // Of every field-service assessment Core decided, how often the deterministic policy found
    // the operator/parts/safety conditions eligible for on-site repair at all.
    pool.query(
      `select count(*) filter (where action='field_repair') as eligible, count(*) as total
       from field_service_decisions
       where ($1::timestamptz is null or created_at>=$1) and ($2::timestamptz is null or created_at<=$2)`,
      [from,to]
    ),
    // Of the field-service jobs that actually started (reached in_progress), how many finished
    // as 'completed' (fixed/stabilized) rather than 'escalated' (failed/escalated outcome).
    pool.query(
      `select count(*) filter (where status='completed') as succeeded, count(*) as started
       from field_service_decisions
       where started_at is not null
         and ($1::timestamptz is null or started_at>=$1) and ($2::timestamptz is null or started_at<=$2)`,
      [from,to]
    ),
    // Of decisions that could plausibly have gone to a tow (the field-repair/stabilization
    // candidates, plus the ones that did end up tow_required), how many instead completed on
    // site without ever invoking Transport.
    pool.query(
      `select
         count(*) filter (where action in ('field_repair','temporary_stabilization') and status='completed') as avoided,
         count(*) filter (where action in ('field_repair','temporary_stabilization','tow_required')) as candidates
       from field_service_decisions
       where ($1::timestamptz is null or created_at>=$1) and ($2::timestamptz is null or created_at<=$2)`,
      [from,to]
    ),
    // Cross-domain handoffs that failed outright: a transport dispatch declined/failed, or a
    // parts order cancelled/failed. Field-service's own outcome failures are already covered by
    // fieldRepairSuccess above, so they're not double-counted here.
    pool.query(
      `select
         (select count(*) filter (where status in ('declined','failed')) from transport_dispatches
          where ($1::timestamptz is null or created_at>=$1) and ($2::timestamptz is null or created_at<=$2)) as transport_failed,
         (select count(*) from transport_dispatches
          where ($1::timestamptz is null or created_at>=$1) and ($2::timestamptz is null or created_at<=$2)) as transport_total,
         (select count(*) filter (where status in ('cancelled','failed')) from parts_orders
          where ($1::timestamptz is null or created_at>=$1) and ($2::timestamptz is null or created_at<=$2)) as parts_failed,
         (select count(*) from parts_orders
          where ($1::timestamptz is null or created_at>=$1) and ($2::timestamptz is null or created_at<=$2)) as parts_total`,
      [from,to]
    ),
    // Open case_exceptions raised per case created in the window.
    pool.query(
      `select
         (select count(*) from case_exceptions ce join service_cases sc on sc.id=ce.case_id
          where ($1::timestamptz is null or sc.created_at>=$1) and ($2::timestamptz is null or sc.created_at<=$2)) as exceptions,
         (select count(*) from service_cases
          where ($1::timestamptz is null or created_at>=$1) and ($2::timestamptz is null or created_at<=$2)) as cases`,
      [from,to]
    ),
    // Blended across the three places a case waits on a customer decision: field-service
    // authorization, a service-plan approval, and a quote decision. Only counts a channel's
    // instances where the customer actually responded (not still pending). service_quotes has no
    // separate decided_at for a decline, so updated_at is used there as an approximation.
    pool.query(
      `select
         avg(extract(epoch from (customer_authorized_at-created_at))/60) filter (where customer_authorization_required and customer_authorized_at is not null) as field_service_minutes,
         count(*) filter (where customer_authorization_required and customer_authorized_at is not null) as field_service_count,
         (select avg(extract(epoch from (decided_at-created_at))/60) from case_approvals
          where decided_at is not null and ($1::timestamptz is null or created_at>=$1) and ($2::timestamptz is null or created_at<=$2)) as approval_minutes,
         (select count(*) from case_approvals
          where decided_at is not null and ($1::timestamptz is null or created_at>=$1) and ($2::timestamptz is null or created_at<=$2)) as approval_count,
         (select avg(extract(epoch from (updated_at-presented_at))/60) from service_quotes
          where presented_at is not null and status in ('accepted','declined') and ($1::timestamptz is null or created_at>=$1) and ($2::timestamptz is null or created_at<=$2)) as quote_minutes,
         (select count(*) from service_quotes
          where presented_at is not null and status in ('accepted','declined') and ($1::timestamptz is null or created_at>=$1) and ($2::timestamptz is null or created_at<=$2)) as quote_count
       from field_service_decisions
       where ($1::timestamptz is null or created_at>=$1) and ($2::timestamptz is null or created_at<=$2)`,
      [from,to]
    ),
    // ROVIQ's own share of quoted revenue: a 'gross' line's full amount, a 'net' line's amount
    // less what its merchant is actually owed (merchant_cost_minor), zero for 'pass_through' and
    // the tax/discount/credit/other adjustment types. A 'net' line with no recorded cost is
    // excluded from the sum entirely rather than assumed to be all-margin or all-cost -- reported
    // separately as missing so the total is legible as a floor, not silently understated as complete.
    pool.query(
      `select
         sum(case
               when revenue_recognition='gross' then line_amount_minor
               when revenue_recognition='net' and merchant_cost_minor is not null then line_amount_minor-merchant_cost_minor
               else 0
             end) as margin_minor,
         count(*) filter (where revenue_recognition='net' and merchant_cost_minor is null) as net_lines_missing_cost,
         count(*) filter (where revenue_recognition='net') as net_lines_total
       from service_quote_lines
       where ($1::timestamptz is null or created_at>=$1) and ($2::timestamptz is null or created_at<=$2)`,
      [from,to]
    )
  ]);

  const cd = caseDuration.rows[0];
  const dc = diagnosticConversion.rows[0];
  const fre = fieldRepairEligibility.rows[0];
  const frs = fieldRepairSuccess.rows[0];
  const ta = towAvoidance.rows[0];
  const hf = handoffFailure.rows[0];
  const ex = exceptionRate.rows[0];
  const crt = customerResponseTime.rows[0];
  const cm = contributionMargin.rows[0];

  const handoffTotal = Number(hf.transport_total) + Number(hf.parts_total);
  const handoffFailed = Number(hf.transport_failed) + Number(hf.parts_failed);

  const responseChannels = [
    { minutes:crt.field_service_minutes, count:Number(crt.field_service_count) },
    { minutes:crt.approval_minutes, count:Number(crt.approval_count) },
    { minutes:crt.quote_minutes, count:Number(crt.quote_count) }
  ].filter((c) => c.count > 0 && c.minutes !== null);
  const responseTotalCount = responseChannels.reduce((sum,c) => sum+c.count,0);
  const blendedResponseMinutes = responseTotalCount > 0
    ? responseChannels.reduce((sum,c) => sum+Number(c.minutes)*c.count,0)/responseTotalCount
    : null;

  return {
    range:{ from, to },
    caseDuration:{
      avgMinutes:cd.avg_minutes!==null?Number(cd.avg_minutes):null,
      medianMinutes:cd.median_minutes!==null?Number(cd.median_minutes):null,
      sampleSize:Number(cd.sample_size)
    },
    // Every rate below carries its raw numerator/denominator alongside it: a 0% rate on zero
    // samples and a 0% rate on a thousand samples are very different findings, and collapsing
    // them to just the ratio would hide that distinction from whoever reads the report.
    diagnosticConversion:{ rate:Number(dc.total)>0?Number(dc.converted)/Number(dc.total):null, converted:Number(dc.converted), total:Number(dc.total) },
    fieldRepairEligibility:{ rate:Number(fre.total)>0?Number(fre.eligible)/Number(fre.total):null, eligible:Number(fre.eligible), total:Number(fre.total) },
    fieldRepairSuccess:{ rate:Number(frs.started)>0?Number(frs.succeeded)/Number(frs.started):null, succeeded:Number(frs.succeeded), started:Number(frs.started) },
    towAvoidance:{ rate:Number(ta.candidates)>0?Number(ta.avoided)/Number(ta.candidates):null, avoided:Number(ta.avoided), candidates:Number(ta.candidates) },
    handoffFailure:{ rate:handoffTotal>0?handoffFailed/handoffTotal:null, failed:handoffFailed, total:handoffTotal },
    exceptionRate:{ rate:Number(ex.cases)>0?Number(ex.exceptions)/Number(ex.cases):null, exceptions:Number(ex.exceptions), cases:Number(ex.cases) },
    customerResponseTimeMinutes:{
      blendedMinutes:blendedResponseMinutes,
      blendedCount:responseTotalCount,
      fieldServiceMinutes:crt.field_service_minutes!==null?Number(crt.field_service_minutes):null,
      fieldServiceCount:Number(crt.field_service_count),
      approvalMinutes:crt.approval_minutes!==null?Number(crt.approval_minutes):null,
      approvalCount:Number(crt.approval_count),
      quoteMinutes:crt.quote_minutes!==null?Number(crt.quote_minutes):null,
      quoteCount:Number(crt.quote_count)
    },
    contributionMargin:{
      marginMinor:cm.margin_minor!==null?Number(cm.margin_minor):0,
      netLinesMissingCost:Number(cm.net_lines_missing_cost),
      netLinesTotal:Number(cm.net_lines_total),
      // false means marginMinor is a floor, not the true total: at least one 'net' line's actual
      // merchant cost was never recorded, so its real contribution (somewhere between 0 and its
      // full line amount) is excluded rather than guessed.
      complete:Number(cm.net_lines_missing_cost)===0
    }
  };
}
