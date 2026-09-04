import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { assertCaseAccess } from './case-access.js';
import { appendCaseEvent } from './orchestration.js';
import { audit } from './audit.js';

export type QuoteLineType = 'diagnostic'|'coordination'|'labor'|'part'|'transport'|'tax'|'discount'|'credit'|'other';
export type RevenueRecognition = 'gross'|'net'|'pass_through';

export type QuoteLineInput = {
  productId?:string;
  lineType:QuoteLineType;
  description:string;
  quantity?:number;
  unitAmountMinor:number;
  merchantActorId?:string;
  revenueRecognition?:RevenueRecognition;
  metadata?:Record<string,unknown>;
};

// Merchant-of-record defaults per line type, taken from the business plan's Section 4B revenue
// model (not invented): labor is never ROVIQ's cut, whether the shop self-prices or accepts a
// platform-set price ("ROVIQ does not take a percentage of labor... the shop keeps 100% of the
// labor portion"), so it passes straight through to the shop. Parts sourced through the vendor
// network are net -- the vendor is owed their cost, ROVIQ recognizes only its markup. Diagnostic
// and tow/valet are the same "platform sets the price, pays a fixed technician/driver payout,
// keeps the spread" mechanic, and the plan's own reporting rule is explicit that this spread --
// not the full ticket -- is what counts as ROVIQ revenue, so both are net. The case coordination
// fee has no third party being paid out at all, so it's ROVIQ's own (gross) revenue. Tax/discount/
// credit/other are financial adjustments, not commercial lines with a counterparty, so they carry
// no merchant-of-record split. These are structural defaults from the documented mechanism, not
// pricing decisions -- amounts (unit_amount_minor) are always caller-supplied, never hardcoded
// here, and a caller can still override the recognition explicitly per line.
const DEFAULT_REVENUE_RECOGNITION:Record<QuoteLineType,RevenueRecognition> = {
  labor:'pass_through',
  part:'net',
  diagnostic:'net',
  transport:'net',
  coordination:'gross',
  tax:'pass_through',
  discount:'pass_through',
  credit:'pass_through',
  other:'pass_through'
};
// Lines with no real counterparty: a merchant-of-record split doesn't apply even under
// 'net'/'pass_through' recognition, since there's no business partner to attribute the money to.
const MERCHANT_EXEMPT_LINE_TYPES:ReadonlySet<QuoteLineType> = new Set(['tax','discount','credit','other']);

export async function createServiceQuote(principal:Principal, caseId:string, input:{ currency?:string; expiresAt?:string; lines:QuoteLineInput[] }) {
  if (!['admin','partner'].includes(principal.role)) throw new Error('forbidden');
  if (!input.lines.length) throw new Error('quote_requires_lines');
  const client = await pool.connect();
  try {
    await client.query('begin');
    await assertCaseAccess(principal,caseId,client);
    if (principal.role === 'partner') {
      if (!principal.actorId) throw new Error('forbidden');
      const accepted = await client.query(
        `select 1 from matches_offers where case_id=$1 and actor_id=$2 and outcome='accepted' limit 1`,
        [caseId,principal.actorId]
      );
      if (!accepted.rowCount) throw new Error('forbidden');
    }
    const plan = await client.query('select id from service_plans where case_id=$1',[caseId]);
    if (!plan.rowCount) throw new Error('service_plan_not_found');
    const serviceCase = await client.query('select customer_actor_id from service_cases where id=$1 for update',[caseId]);
    if (!serviceCase.rowCount) throw new Error('case_not_found');
    const currency = (input.currency ?? 'USD').toUpperCase();

    // Supersede any prior quote for this case still open for action before creating a new one --
    // otherwise a customer could accept/decline stale terms after a newer quote replaced them,
    // the same class of bug fixed in decideApproval's stale-revision check. Since at most one
    // quote per case is ever draft/presented at a time, a decision always targets current terms
    // by construction, with no separate revision check needed at decision time.
    await client.query(`update service_quotes set status='superseded',updated_at=now() where case_id=$1 and status in ('draft','presented')`,[caseId]);

    const revisionResult = await client.query('select coalesce(max(revision),0)+1 as next from service_quotes where case_id=$1',[caseId]);
    const revision = Number(revisionResult.rows[0].next);

    let subtotalMinor = 0;
    let taxMinor = 0;
    const lineRows:{lineType:QuoteLineType;description:string;quantity:number;unitAmountMinor:number;lineAmountMinor:number;productId:string|null;merchantActorId:string|null;revenueRecognition:RevenueRecognition;metadata:Record<string,unknown>}[] = [];
    for (const line of input.lines) {
      if (!(line.unitAmountMinor >= 0)) throw new Error('invalid_line_amount');
      const quantity = line.quantity ?? 1;
      if (!(quantity > 0)) throw new Error('invalid_line_quantity');
      const revenueRecognition = line.revenueRecognition ?? DEFAULT_REVENUE_RECOGNITION[line.lineType];
      const merchantExempt = MERCHANT_EXEMPT_LINE_TYPES.has(line.lineType);
      if (!merchantExempt && revenueRecognition !== 'gross' && !line.merchantActorId) {
        throw new Error('merchant_required_for_recognized_revenue');
      }
      const lineAmountMinor = Math.round(quantity * line.unitAmountMinor);
      if (line.lineType === 'tax') taxMinor += lineAmountMinor; else subtotalMinor += lineAmountMinor;
      lineRows.push({
        lineType:line.lineType, description:line.description, quantity, unitAmountMinor:line.unitAmountMinor, lineAmountMinor,
        productId:line.productId ?? null, merchantActorId:merchantExempt ? null : (line.merchantActorId ?? null),
        revenueRecognition, metadata:line.metadata ?? {}
      });
    }
    const totalMinor = subtotalMinor + taxMinor;

    const quote = await client.query(
      `insert into service_quotes(case_id,service_plan_id,revision,seller_actor_id,customer_actor_id,status,subtotal_minor,tax_minor,total_minor,currency,expires_at)
       values($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10) returning *`,
      [caseId,plan.rows[0].id,revision,principal.actorId ?? null,serviceCase.rows[0].customer_actor_id,subtotalMinor,taxMinor,totalMinor,currency,input.expiresAt ?? null]
    );
    for (const line of lineRows) {
      await client.query(
        `insert into service_quote_lines(quote_id,product_id,line_type,description,quantity,unit_amount_minor,line_amount_minor,merchant_actor_id,revenue_recognition,metadata)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [quote.rows[0].id,line.productId,line.lineType,line.description,line.quantity,line.unitAmountMinor,line.lineAmountMinor,line.merchantActorId,line.revenueRecognition,JSON.stringify(line.metadata)]
      );
    }
    await client.query(
      `insert into events(aggregate_type,aggregate_id,event_type,actor_id,payload) values('service_case',$1,'SERVICE_QUOTE_CREATED',$2,$3)`,
      [caseId,principal.actorId??null,JSON.stringify({quoteId:quote.rows[0].id,revision,totalMinor,currency})]
    );
    await client.query('commit');
    await audit(principal,'create_service_quote','service_quote',quote.rows[0].id,'case_quote',{caseId,revision,totalMinor});
    return getServiceQuote(quote.rows[0].id);
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

export async function presentServiceQuote(principal:Principal, caseId:string, quoteId:string) {
  if (!['admin','partner'].includes(principal.role)) throw new Error('forbidden');
  const client = await pool.connect();
  try {
    await client.query('begin');
    await assertCaseAccess(principal,caseId,client);
    const current = await client.query('select * from service_quotes where id=$1 and case_id=$2 for update',[quoteId,caseId]);
    if (!current.rowCount) throw new Error('quote_not_found');
    if (current.rows[0].status !== 'draft') throw new Error('quote_not_presentable');
    const updated = await client.query(`update service_quotes set status='presented',presented_at=now(),updated_at=now() where id=$1 returning *`,[quoteId]);
    await client.query('commit');
    await appendCaseEvent(caseId,'SERVICE_QUOTE_PRESENTED',principal,{quoteId});
    await audit(principal,'present_service_quote','service_quote',quoteId,'case_quote',{caseId});
    return updated.rows[0];
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

export async function decideServiceQuote(principal:Principal, caseId:string, quoteId:string, decision:'accepted'|'declined') {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await assertCaseAccess(principal,caseId,client);
    const current = await client.query('select * from service_quotes where id=$1 and case_id=$2 for update',[quoteId,caseId]);
    if (!current.rowCount) throw new Error('quote_not_found');
    const quote = current.rows[0];
    if (quote.status !== 'presented') throw new Error('quote_not_awaiting_decision');
    if (principal.role !== 'admin' && quote.customer_actor_id !== principal.actorId) throw new Error('forbidden');
    const updated = await client.query(
      `update service_quotes set status=$1,accepted_at=case when $1='accepted' then now() else accepted_at end,updated_at=now() where id=$2 returning *`,
      [decision,quoteId]
    );
    await client.query('commit');
    await appendCaseEvent(caseId,decision==='accepted'?'SERVICE_QUOTE_ACCEPTED':'SERVICE_QUOTE_DECLINED',principal,{quoteId});
    await audit(principal,'decide_service_quote','service_quote',quoteId,decision,{caseId});
    return updated.rows[0];
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

export async function getServiceQuote(quoteId:string) {
  const quote = await pool.query('select * from service_quotes where id=$1',[quoteId]);
  if (!quote.rowCount) return null;
  const lines = await pool.query('select * from service_quote_lines where quote_id=$1 order by created_at asc',[quoteId]);
  return { quote:quote.rows[0], lines:lines.rows };
}

export async function listServiceQuotes(principal:Principal, caseId:string) {
  await assertCaseAccess(principal,caseId);
  const r = await pool.query('select * from service_quotes where case_id=$1 order by revision desc',[caseId]);
  return r.rows;
}
