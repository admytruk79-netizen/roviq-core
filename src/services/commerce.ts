import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { audit } from './audit.js';

// This service is deliberately just plumbing: MVP_EXECUTION_PLAN.md backlog #11 asks to "seed
// Portland pilot products/price books with finance-approved values outside public source" --
// real dollar figures that must come from the business, not from code. commercial_products/
// price_books/price_book_items (migrations/016_service_plan_commerce.sql) existed in the schema
// with nothing reading or writing them; this gives an admin a real way to enter those numbers
// once finance approves them, without this file ever inventing or defaulting a price itself.

export async function createCommercialProduct(principal:Principal, input:{
  code:string; productType:'partner_subscription'|'diagnostic_coordination'|'case_coordination'|'transport'|'parts'|'customer_membership'|'prepaid_plan'|'enterprise';
  name:string; description?:string; active?:boolean; attributes?:Record<string,unknown>;
}) {
  const r = await pool.query(
    `insert into commercial_products(code,product_type,name,description,active,attributes)
     values($1,$2,$3,$4,$5,$6) returning *`,
    [input.code,input.productType,input.name,input.description ?? null,input.active ?? true,JSON.stringify(input.attributes ?? {})]
  );
  await audit(principal,'create_commercial_product','commercial_product',r.rows[0].id,'pricing_catalog',{code:input.code,productType:input.productType});
  return r.rows[0];
}

export async function listCommercialProducts(activeOnly:boolean) {
  const r = await pool.query(
    activeOnly ? `select * from commercial_products where active=true order by product_type,code` : `select * from commercial_products order by product_type,code`
  );
  return r.rows;
}

export async function createPriceBook(principal:Principal, input:{
  code:string; marketId?:string; audienceType:'customer'|'partner'|'fleet'|'enterprise';
  currency?:string; startsAt:string; endsAt?:string; active?:boolean;
}) {
  const r = await pool.query(
    `insert into price_books(code,market_id,audience_type,currency,starts_at,ends_at,active)
     values($1,$2,$3,$4,$5,$6,$7) returning *`,
    [input.code,input.marketId ?? null,input.audienceType,(input.currency ?? 'USD').toUpperCase(),input.startsAt,input.endsAt ?? null,input.active ?? true]
  );
  await audit(principal,'create_price_book','price_book',r.rows[0].id,'pricing_catalog',{code:input.code,audienceType:input.audienceType});
  return r.rows[0];
}

export async function listPriceBooks(activeOnly:boolean) {
  const r = await pool.query(
    activeOnly ? `select * from price_books where active=true order by starts_at desc` : `select * from price_books order by starts_at desc`
  );
  return r.rows;
}

export async function addPriceBookItem(principal:Principal, priceBookId:string, input:{
  productId:string; unitAmountMinor:number; billingInterval?:'one_time'|'monthly'|'annual'; conditions?:Record<string,unknown>;
}) {
  const book = await pool.query('select id from price_books where id=$1',[priceBookId]);
  if (!book.rowCount) throw new Error('price_book_not_found');
  const product = await pool.query('select id from commercial_products where id=$1',[input.productId]);
  if (!product.rowCount) throw new Error('commercial_product_not_found');
  if (!(input.unitAmountMinor >= 0)) throw new Error('invalid_unit_amount');
  const r = await pool.query(
    `insert into price_book_items(price_book_id,product_id,unit_amount_minor,billing_interval,conditions)
     values($1,$2,$3,$4,$5)
     on conflict(price_book_id,product_id,billing_interval) do update set unit_amount_minor=excluded.unit_amount_minor,conditions=excluded.conditions
     returning *`,
    [priceBookId,input.productId,input.unitAmountMinor,input.billingInterval ?? 'one_time',JSON.stringify(input.conditions ?? {})]
  );
  await audit(principal,'set_price_book_item','price_book_item',r.rows[0].id,'pricing_catalog',{priceBookId,productId:input.productId,unitAmountMinor:input.unitAmountMinor});
  return r.rows[0];
}

export async function listPriceBookItems(priceBookId:string) {
  const book = await pool.query('select id from price_books where id=$1',[priceBookId]);
  if (!book.rowCount) throw new Error('price_book_not_found');
  const r = await pool.query(
    `select pbi.*, cp.code as product_code, cp.name as product_name, cp.product_type
     from price_book_items pbi join commercial_products cp on cp.id=pbi.product_id
     where pbi.price_book_id=$1 order by cp.product_type,cp.code`,
    [priceBookId]
  );
  return r.rows;
}
