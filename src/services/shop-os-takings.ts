import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { resolveShopPrincipalScope } from './shop-os-scope.js';

// The shop's own books, day by day: jobs finished, what they earned and cost (from the settled
// ledger entries), money actually collected by method, and walk-in jobs still owing. ROVIQ network
// jobs are paid through ROVIQ and settled to the shop, so they never show as owing here.

const round = (v: unknown) => Math.round(Number(v ?? 0) * 100) / 100;

function validTimeZone(tz: string) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

export async function getShopTakings(principal: Principal, input: { from: string; to: string; timeZone?: string; organizationId?: string; locationId?: string }) {
  const scope = await resolveShopPrincipalScope(principal, { organizationId: input.organizationId, locationId: input.locationId }, pool);
  const tz = input.timeZone && validTimeZone(input.timeZone) ? input.timeZone : 'UTC';
  const params = [scope.organizationId, scope.locationId, input.from, input.to, tz];
  const [jobs, collected, outstanding, unsettled] = await Promise.all([
    pool.query(
      `select to_char(ro.completed_at at time zone $5,'YYYY-MM-DD') as day, count(*)::int as jobs,
              coalesce(sum(le.revenue),0) as revenue, coalesce(sum(le.direct),0) as direct_cost, coalesce(sum(le.labor),0) as labor_cost
         from shop_repair_orders ro
         left join lateral (
           select sum(amount) filter (where reconciliation_key='shop_os_revenue') as revenue,
                  -sum(amount) filter (where reconciliation_key='shop_os_direct_cost') as direct,
                  -sum(amount) filter (where reconciliation_key='shop_os_labor_cost') as labor
             from ledger_entries where repair_order_id=ro.id) le on true
        where ro.organization_id=$1 and ($2::uuid is null or ro.location_id=$2)
          and ro.status in ('completed','closed') and ro.completed_at>=$3::timestamptz and ro.completed_at<$4::timestamptz
        group by 1 order by 1`, params),
    pool.query(
      `select to_char(p.paid_at at time zone $5,'YYYY-MM-DD') as day, p.method, sum(p.amount) as amount
         from shop_payments p join shop_repair_orders ro on ro.id=p.repair_order_id
        where p.organization_id=$1 and ($2::uuid is null or ro.location_id=$2) and p.status='paid'
          and p.paid_at>=$3::timestamptz and p.paid_at<$4::timestamptz
        group by 1,2 order by 1`, params),
    pool.query(
      `select ro.id, ro.repair_order_number, ro.completed_at, ro.approved_amount, c.display_name as customer,
              concat_ws(' ', v.model_year, v.make, v.model) as vehicle,
              ro.approved_amount-coalesce((select sum(amount) from shop_payments where repair_order_id=ro.id and status='paid'),0) as balance
         from shop_repair_orders ro
         left join shop_customers c on c.id=ro.shop_customer_id
         left join shop_vehicles v on v.id=ro.shop_vehicle_id
        where ro.organization_id=$1 and ($2::uuid is null or ro.location_id=$2) and ro.service_case_id is null
          and ro.status in ('completed','closed')
          and ro.approved_amount>coalesce((select sum(amount) from shop_payments where repair_order_id=ro.id and status='paid'),0)
        order by ro.completed_at asc limit 50`, [scope.organizationId, scope.locationId]),
    pool.query(
      `select count(*)::int as n from shop_repair_orders ro
        where ro.organization_id=$1 and ($2::uuid is null or ro.location_id=$2) and ro.status in ('completed','closed')
          and not exists (select 1 from ledger_entries le where le.repair_order_id=ro.id and le.reconciliation_key='shop_os_revenue')`,
      [scope.organizationId, scope.locationId])
  ]);
  const days = new Map<string, { day: string; jobs: number; revenue: number; directCost: number; laborCost: number; contribution: number; collected: Record<string, number> }>();
  const dayRow = (day: string) => {
    if (!days.has(day)) days.set(day, { day, jobs: 0, revenue: 0, directCost: 0, laborCost: 0, contribution: 0, collected: {} });
    return days.get(day)!;
  };
  for (const r of jobs.rows) {
    const d = dayRow(r.day);
    d.jobs = r.jobs; d.revenue = round(r.revenue); d.directCost = round(r.direct_cost); d.laborCost = round(r.labor_cost);
    d.contribution = round(d.revenue - d.directCost - d.laborCost);
  }
  for (const r of collected.rows) dayRow(r.day).collected[r.method] = round(r.amount);
  const list = [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
  const sum = (f: (d: (typeof list)[number]) => number) => round(list.reduce((s, d) => s + f(d), 0));
  return {
    timeZone: tz,
    days: list,
    totals: {
      jobs: list.reduce((s, d) => s + d.jobs, 0), revenue: sum((d) => d.revenue), directCost: sum((d) => d.directCost), laborCost: sum((d) => d.laborCost),
      contribution: sum((d) => d.contribution), collected: sum((d) => Object.values(d.collected).reduce((a, b) => a + b, 0))
    },
    outstanding: outstanding.rows.map((r) => ({ repairOrderId: r.id, number: r.repair_order_number, customer: r.customer, vehicle: r.vehicle || null, completedAt: r.completed_at, balance: round(r.balance) })),
    unsettledJobs: unsettled.rows[0].n
  };
}
