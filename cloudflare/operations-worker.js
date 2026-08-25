import { timingSafeEqual } from 'node:crypto';
import { jwtVerify } from 'jose';
import { Client } from 'pg';
import accessWorker from './access-worker.js';

const JWT_ISSUER = 'roviq-core';
const JWT_AUDIENCE = 'roviq-apps';
const ALLOWED_ROLES = new Set(['admin','customer','partner','diagnostic','tow','parts','fleet']);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

async function readJson(request) {
  const type = request.headers.get('content-type') || '';
  if (!type.toLowerCase().includes('application/json')) throw new Error('content_type_must_be_application_json');
  return await request.json();
}

async function withClient(env, fn) {
  if (!env.HYPERDRIVE?.connectionString) throw new Error('hyperdrive_binding_missing');
  const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
  await client.connect();
  try { return await fn(client); }
  finally { await client.end().catch(() => undefined); }
}

async function tx(env, fn) {
  return await withClient(env, async (client) => {
    await client.query('begin');
    try {
      const value = await fn(client);
      await client.query('commit');
      return value;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
}

function jwtSecret(env) {
  if (!env.ROVIQ_JWT_SECRET || String(env.ROVIQ_JWT_SECRET).length < 32) throw new Error('jwt_secret_not_configured');
  return new TextEncoder().encode(String(env.ROVIQ_JWT_SECRET));
}

async function principalFromRequest(request, env) {
  const auth = request.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) throw new Error('unauthorized');
  try {
    const { payload } = await jwtVerify(auth.slice(7), jwtSecret(env), { issuer: JWT_ISSUER, audience: JWT_AUDIENCE });
    const role = String(payload.role || '');
    const actorId = typeof payload.actorId === 'string' ? payload.actorId : null;
    if (!payload.sub || !ALLOWED_ROLES.has(role)) throw new Error('unauthorized');
    if (role !== 'admin' && !actorId) throw new Error('unauthorized');
    return { identityId: String(payload.sub), role, actorId };
  } catch (error) {
    if (String(error?.message || error) === 'jwt_secret_not_configured') throw error;
    throw new Error('unauthorized');
  }
}

function requireInternalAuth(request, env) {
  const secret = env.ROVIQ_E2E_TOKEN;
  if (!secret) throw new Error('internal_auth_not_configured');
  const auth = request.headers.get('authorization') || '';
  const supplied = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const a = Buffer.from(String(secret));
  const b = Buffer.from(String(supplied));
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('unauthorized');
}

function requireRole(principal, roles) {
  if (!roles.includes(principal.role)) throw new Error('forbidden');
}

async function requireCase(client, caseId) {
  const result = await client.query(`select * from service_cases where id=$1`, [caseId]);
  if (!result.rowCount) throw new Error('case_not_found');
  return result.rows[0];
}

async function requireCustomerCaseAccess(client, principal, serviceCase) {
  if (principal.role === 'admin') return;
  if (principal.role === 'customer' && serviceCase.customer_actor_id === principal.actorId) return;
  if (principal.role === 'partner') {
    if (serviceCase.current_owner_actor_id === principal.actorId) return;
    const relation = await client.query(`select 1 from case_commitments where case_id=$1 and provider_actor_id=$2 limit 1`, [serviceCase.id, principal.actorId]);
    if (relation.rowCount) return;
  }
  throw new Error('forbidden');
}

async function appendEvent(client, caseId, eventType, payload = {}, actorId = null) {
  await client.query(
    `insert into events(aggregate_type,aggregate_id,event_type,actor_id,payload)
     values('service_case',$1,$2,$3,$4::jsonb)`,
    [caseId, eventType, actorId, JSON.stringify(payload)]
  );
}

async function audit(client, principal, action, objectType, objectId, metadata = {}) {
  await client.query(
    `insert into audit_log(principal_role,principal_actor_id,action,object_type,object_id,rule_basis,metadata)
     values($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [principal.role, principal.actorId || null, action, objectType, String(objectId), 'operations-role-policy-v1', JSON.stringify(metadata)]
  );
}

async function createMobilityAllocation(env, principal, caseId, body = {}) {
  requireRole(principal, ['admin','customer','partner']);
  return await tx(env, async (client) => {
    const serviceCase = await requireCase(client, caseId);
    await requireCustomerCaseAccess(client, principal, serviceCase);
    const type = String(body.allocationType || body.resourceType || 'loaner');
    const resource = await client.query(
      `select mr.*
         from mobility_resources mr
         join actors a on a.id=mr.actor_id and a.status='active'
        where mr.status='available'
          and mr.resource_type=$1
          and (mr.available_from is null or mr.available_from<=now())
          and (mr.available_until is null or mr.available_until>now())
          and not exists (
            select 1 from mobility_allocations ma
             where ma.resource_id=mr.id and ma.state in ('reserved','assigned','active','return_pending')
          )
        order by mr.available_from nulls first,mr.created_at asc
        limit 1
        for update of mr skip locked`,
      [type]
    );

    const selected = resource.rows[0] || null;
    const allocation = await client.query(
      `insert into mobility_allocations(case_id,customer_actor_id,provider_actor_id,resource_id,allocation_type,state,reserved_at,return_due_at,notes,metadata)
       values($1,$2,$3,$4,$5,$6,case when $6='reserved' then now() else null end,$7,$8,$9::jsonb) returning *`,
      [caseId, serviceCase.customer_actor_id, selected?.actor_id || null, selected?.id || null, type, selected ? 'reserved' : 'requested', body.returnDueAt || null, body.notes || null, JSON.stringify({ source: 'roviq-core-operations-v1', ...(body.metadata || {}) })]
    );

    if (selected) {
      await client.query(`update mobility_resources set status='reserved',updated_at=now() where id=$1`, [selected.id]);
      await appendEvent(client, caseId, 'MOBILITY_RESERVED', { allocationId: allocation.rows[0].id, resourceId: selected.id, providerActorId: selected.actor_id, allocationType: type }, principal.actorId);
    } else {
      const exception = await client.query(
        `insert into case_exceptions(case_id,exception_code,severity,state,summary,metadata)
         values($1,'NO_MOBILITY_RESOURCE','warning','open',$2,$3::jsonb) returning *`,
        [caseId, `No ${type} mobility resource is currently available.`, JSON.stringify({ allocationId: allocation.rows[0].id, allocationType: type })]
      );
      await appendEvent(client, caseId, 'MOBILITY_EXCEPTION', { allocationId: allocation.rows[0].id, exceptionId: exception.rows[0].id, allocationType: type }, principal.actorId);
    }
    await audit(client, principal, 'mobility.request', 'mobility_allocation', allocation.rows[0].id, { caseId, resourceFound: Boolean(selected) });
    return { ok: true, allocation: allocation.rows[0], resource: selected, resourceFound: Boolean(selected) };
  });
}

async function updateMobilityAllocation(env, principal, caseId, allocationId, body = {}) {
  requireRole(principal, ['admin','fleet']);
  const allowed = new Set(['reserved','assigned','active','return_pending','completed','declined','cancelled','failed']);
  if (!allowed.has(body.state)) throw new Error('invalid_mobility_state');
  return await tx(env, async (client) => {
    await requireCase(client, caseId);
    const existing = await client.query(`select * from mobility_allocations where id=$1 and case_id=$2 for update`, [allocationId, caseId]);
    if (!existing.rowCount) throw new Error('mobility_allocation_not_found');
    if (principal.role === 'fleet' && existing.rows[0].provider_actor_id !== principal.actorId) throw new Error('forbidden');
    const updated = await client.query(
      `update mobility_allocations
          set state=$1,
              assigned_at=case when $1='assigned' and assigned_at is null then now() else assigned_at end,
              activated_at=case when $1='active' and activated_at is null then now() else activated_at end,
              returned_at=case when $1='completed' and returned_at is null then now() else returned_at end,
              completed_at=case when $1='completed' then now() else completed_at end,
              cancelled_at=case when $1='cancelled' then now() else cancelled_at end,
              notes=coalesce($2,notes),metadata=metadata || $3::jsonb,updated_at=now()
        where id=$4 returning *`,
      [body.state, body.notes || null, JSON.stringify(body.metadata || {}), allocationId]
    );
    if (existing.rows[0].resource_id && ['completed','declined','cancelled','failed'].includes(body.state)) {
      await client.query(`update mobility_resources set status='available',updated_at=now() where id=$1 and status<>'retired'`, [existing.rows[0].resource_id]);
    } else if (existing.rows[0].resource_id && ['assigned','active','return_pending'].includes(body.state)) {
      await client.query(`update mobility_resources set status='assigned',updated_at=now() where id=$1`, [existing.rows[0].resource_id]);
    }
    await appendEvent(client, caseId, 'MOBILITY_STATUS_CHANGED', { allocationId, from: existing.rows[0].state, to: body.state }, principal.actorId);
    await audit(client, principal, 'mobility.update', 'mobility_allocation', allocationId, { caseId, state: body.state });
    return { ok: true, allocation: updated.rows[0] };
  });
}

async function createPartsOrder(env, principal, caseId, body = {}) {
  requireRole(principal, ['admin','partner']);
  if (!Array.isArray(body.items) || !body.items.length) throw new Error('parts_items_required');
  return await tx(env, async (client) => {
    const serviceCase = await requireCase(client, caseId);
    if (principal.role === 'partner') await requireCustomerCaseAccess(client, principal, serviceCase);

    const requested = body.items.map((item) => ({
      sku: String(item.sku || '').trim(),
      quantity: Number(item.quantity || 0),
      description: item.description || null,
      partNumber: item.partNumber || null
    }));
    if (requested.some((item) => !item.sku || !Number.isInteger(item.quantity) || item.quantity <= 0)) throw new Error('invalid_parts_items');

    let supplierActorId = body.supplierActorId || null;
    if (!supplierActorId) {
      const supplier = await client.query(
        `select pi.supplier_actor_id
           from parts_inventory pi
          where pi.active=true and pi.sku=$1 and (pi.quantity_on_hand-pi.quantity_reserved)>=$2
          order by (pi.quantity_on_hand-pi.quantity_reserved) desc,pi.updated_at desc
          limit 1`,
        [requested[0].sku, requested[0].quantity]
      );
      supplierActorId = supplier.rows[0]?.supplier_actor_id || null;
    }

    const reservations = [];
    let allAvailable = Boolean(supplierActorId);
    if (supplierActorId) {
      for (const item of requested) {
        const inventory = await client.query(
          `select * from parts_inventory
            where supplier_actor_id=$1 and active=true and sku=$2
              and (quantity_on_hand-quantity_reserved)>=$3
            order by updated_at desc
            limit 1
            for update`,
          [supplierActorId, item.sku, item.quantity]
        );
        if (!inventory.rowCount) { allAvailable = false; reservations.push({ item, inventory: null }); }
        else reservations.push({ item, inventory: inventory.rows[0] });
      }
    }

    const orderStatus = allAvailable ? 'reserved' : (supplierActorId ? 'supplier_assigned' : 'requested');
    const order = await client.query(
      `insert into parts_orders(case_id,requested_by_actor_id,supplier_actor_id,status,needed_by,attributes)
       values($1,$2,$3,$4,$5,$6::jsonb) returning *`,
      [caseId, principal.actorId || null, supplierActorId, orderStatus, body.neededBy || null, JSON.stringify({ source: 'roviq-core-operations-v1', ...(body.attributes || {}) })]
    );

    const createdItems = [];
    for (const reservation of reservations.length ? reservations : requested.map((item) => ({ item, inventory: null }))) {
      const inv = reservation.inventory;
      if (inv && allAvailable) {
        await client.query(`update parts_inventory set quantity_reserved=quantity_reserved+$1,updated_at=now() where id=$2`, [reservation.item.quantity, inv.id]);
      }
      const created = await client.query(
        `insert into parts_order_items(order_id,inventory_id,sku,part_number,description,quantity,unit_price,currency,status,attributes)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) returning *`,
        [order.rows[0].id, inv?.id || null, reservation.item.sku, reservation.item.partNumber || inv?.part_number || null,
         reservation.item.description || inv?.description || null, reservation.item.quantity, inv?.unit_price || null, inv?.currency || 'USD', allAvailable && inv ? 'reserved' : 'requested', JSON.stringify({ source: 'roviq-core-operations-v1' })]
      );
      createdItems.push(created.rows[0]);
    }

    if (!allAvailable) {
      const missing = createdItems.filter((item) => !item.inventory_id).map((item) => ({ sku: item.sku, quantity: item.quantity }));
      const exception = await client.query(
        `insert into case_exceptions(case_id,exception_code,severity,state,summary,metadata)
         values($1,'PARTS_UNAVAILABLE','warning','open',$2,$3::jsonb) returning *`,
        [caseId, 'One or more required parts are not currently reservable from a single supplier.', JSON.stringify({ partsOrderId: order.rows[0].id, missing })]
      );
      await appendEvent(client, caseId, 'PARTS_EXCEPTION', { partsOrderId: order.rows[0].id, exceptionId: exception.rows[0].id, missing }, principal.actorId);
    } else {
      if (serviceCase.state === 'repair_in_progress') {
        await client.query(`update service_cases set state='parts_pending',version=version+1,updated_at=now() where id=$1`, [caseId]);
      }
      await appendEvent(client, caseId, 'PARTS_RESERVED', { partsOrderId: order.rows[0].id, supplierActorId, itemCount: createdItems.length }, principal.actorId);
    }
    await audit(client, principal, 'parts.order.create', 'parts_order', order.rows[0].id, { caseId, allAvailable });
    return { ok: true, order: order.rows[0], items: createdItems, allAvailable };
  });
}

async function updatePartsOrder(env, principal, caseId, orderId, body = {}) {
  requireRole(principal, ['admin','parts']);
  const allowed = new Set(['supplier_assigned','reserved','ordered','shipped','delivered','cancelled','failed']);
  if (!allowed.has(body.status)) throw new Error('invalid_parts_status');
  return await tx(env, async (client) => {
    const serviceCase = await requireCase(client, caseId);
    const existing = await client.query(`select * from parts_orders where id=$1 and case_id=$2 for update`, [orderId, caseId]);
    if (!existing.rowCount) throw new Error('parts_order_not_found');
    if (principal.role === 'parts' && existing.rows[0].supplier_actor_id !== principal.actorId) throw new Error('forbidden');
    const updated = await client.query(
      `update parts_orders set status=$1,tracking_reference=coalesce($2,tracking_reference),external_order_reference=coalesce($3,external_order_reference),
       attributes=attributes || $4::jsonb,updated_at=now(),delivered_at=case when $1='delivered' then now() else delivered_at end,
       cancelled_at=case when $1='cancelled' then now() else cancelled_at end where id=$5 returning *`,
      [body.status, body.trackingReference || null, body.externalOrderReference || null, JSON.stringify(body.attributes || {}), orderId]
    );
    await client.query(`update parts_order_items set status=$1,updated_at=now() where order_id=$2 and status not in ('cancelled','failed')`, [body.status, orderId]);
    if (body.status === 'delivered' && serviceCase.state === 'parts_pending') {
      await client.query(`update service_cases set state='repair_in_progress',version=version+1,updated_at=now() where id=$1`, [caseId]);
    }
    await appendEvent(client, caseId, 'PARTS_STATUS_CHANGED', { partsOrderId: orderId, from: existing.rows[0].status, to: body.status }, principal.actorId);
    await audit(client, principal, 'parts.order.update', 'parts_order', orderId, { caseId, status: body.status });
    return { ok: true, order: updated.rows[0] };
  });
}

async function createQuote(env, principal, caseId, body = {}) {
  requireRole(principal, ['admin','partner']);
  if (!Array.isArray(body.lines) || !body.lines.length) throw new Error('quote_lines_required');
  return await tx(env, async (client) => {
    const serviceCase = await requireCase(client, caseId);
    if (principal.role === 'partner') await requireCustomerCaseAccess(client, principal, serviceCase);
    const plan = (await client.query(`select * from service_plans where case_id=$1`, [caseId])).rows[0] || null;
    const revisionResult = await client.query(`select coalesce(max(revision),0)::int+1 as revision from service_quotes where case_id=$1`, [caseId]);
    const revision = revisionResult.rows[0].revision;
    const lines = body.lines.map((line) => {
      const quantity = Number(line.quantity ?? 1);
      const unitAmountMinor = Number(line.unitAmountMinor);
      if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isInteger(unitAmountMinor)) throw new Error('invalid_quote_line');
      return { ...line, quantity, unitAmountMinor, lineAmountMinor: Math.round(quantity * unitAmountMinor) };
    });
    const subtotal = lines.reduce((sum, line) => sum + line.lineAmountMinor, 0);
    const tax = Number.isInteger(body.taxMinor) ? body.taxMinor : 0;
    const total = subtotal + tax;
    if (total < 0) throw new Error('invalid_quote_total');
    const quote = await client.query(
      `insert into service_quotes(case_id,service_plan_id,revision,seller_actor_id,customer_actor_id,status,subtotal_minor,tax_minor,total_minor,currency,expires_at,presented_at)
       values($1,$2,$3,$4,$5,'presented',$6,$7,$8,$9,$10,now()) returning *`,
      [caseId, plan?.id || null, revision, principal.actorId || body.sellerActorId || null, serviceCase.customer_actor_id, subtotal, tax, total, body.currency || plan?.currency || 'USD', body.expiresAt || null]
    );
    for (const line of lines) {
      await client.query(
        `insert into service_quote_lines(quote_id,product_id,line_type,description,quantity,unit_amount_minor,line_amount_minor,merchant_actor_id,revenue_recognition,metadata)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
        [quote.rows[0].id, line.productId || null, line.lineType || 'other', String(line.description || 'Service item'), line.quantity, line.unitAmountMinor,
         line.lineAmountMinor, line.merchantActorId || principal.actorId || null, line.revenueRecognition || 'gross', JSON.stringify(line.metadata || {})]
      );
    }
    if (plan) await client.query(`update service_plans set estimated_total_minor=$1,currency=$2,status=case when status='draft' then 'proposed' else status end,updated_at=now() where id=$3`, [total, quote.rows[0].currency, plan.id]);
    await appendEvent(client, caseId, 'QUOTE_PRESENTED', { quoteId: quote.rows[0].id, revision, totalMinor: total, currency: quote.rows[0].currency }, principal.actorId);
    await audit(client, principal, 'quote.create', 'service_quote', quote.rows[0].id, { caseId, totalMinor: total });
    return { ok: true, quote: quote.rows[0], lines };
  });
}

async function acceptQuote(env, principal, caseId, quoteId) {
  requireRole(principal, ['admin','customer']);
  return await tx(env, async (client) => {
    const serviceCase = await requireCase(client, caseId);
    if (principal.role === 'customer' && serviceCase.customer_actor_id !== principal.actorId) throw new Error('forbidden');
    const quote = await client.query(`select * from service_quotes where id=$1 and case_id=$2 for update`, [quoteId, caseId]);
    if (!quote.rowCount) throw new Error('quote_not_found');
    if (!['presented','draft'].includes(quote.rows[0].status)) throw new Error('quote_not_acceptible');
    if (quote.rows[0].expires_at && new Date(quote.rows[0].expires_at).getTime() <= Date.now()) throw new Error('quote_expired');
    const updated = await client.query(`update service_quotes set status='accepted',accepted_at=now(),updated_at=now() where id=$1 returning *`, [quoteId]);
    if (quote.rows[0].service_plan_id) {
      await client.query(`update service_plans set approved_total_minor=$1,currency=$2,approved_by_actor_id=$3,approved_at=now(),status='approved',updated_at=now() where id=$4`, [quote.rows[0].total_minor, quote.rows[0].currency, principal.actorId || serviceCase.customer_actor_id, quote.rows[0].service_plan_id]);
    }
    await appendEvent(client, caseId, 'QUOTE_ACCEPTED', { quoteId, totalMinor: quote.rows[0].total_minor, currency: quote.rows[0].currency }, principal.actorId);
    await audit(client, principal, 'quote.accept', 'service_quote', quoteId, { caseId });
    return { ok: true, quote: updated.rows[0] };
  });
}

async function createPayment(env, principal, caseId, body = {}) {
  requireRole(principal, ['admin','customer']);
  return await tx(env, async (client) => {
    const serviceCase = await requireCase(client, caseId);
    if (principal.role === 'customer' && serviceCase.customer_actor_id !== principal.actorId) throw new Error('forbidden');
    let amountMinor = body.amountMinor;
    let currency = body.currency || 'USD';
    let quoteId = body.quoteId || null;
    if (quoteId) {
      const quote = await client.query(`select * from service_quotes where id=$1 and case_id=$2`, [quoteId, caseId]);
      if (!quote.rowCount) throw new Error('quote_not_found');
      if (quote.rows[0].status !== 'accepted') throw new Error('quote_not_accepted');
      amountMinor = Number(quote.rows[0].total_minor);
      currency = quote.rows[0].currency;
    }
    if (!Number.isInteger(amountMinor) || amountMinor < 0) throw new Error('invalid_payment_amount');
    const amountMajor = (amountMinor / 100).toFixed(2);
    const intent = await client.query(
      `insert into payment_intents(case_id,customer_actor_id,provider,provider_intent_id,amount,currency,state,description,metadata)
       values($1,$2,$3,$4,$5,$6,'created',$7,$8::jsonb) returning *`,
      [caseId, serviceCase.customer_actor_id, body.provider || 'manual', body.providerIntentId || null, amountMajor, currency,
       body.description || 'ROVIQ coordinated service payment', JSON.stringify({ amountMinor, quoteId, source: 'roviq-core-operations-v1', ...(body.metadata || {}) })]
    );
    await client.query(`insert into payment_events(payment_intent_id,event_type,amount,payload) values($1,'created',$2,$3::jsonb)`, [intent.rows[0].id, amountMajor, JSON.stringify({ amountMinor, quoteId })]);
    await appendEvent(client, caseId, 'PAYMENT_INTENT_CREATED', { paymentIntentId: intent.rows[0].id, amountMinor, currency, quoteId }, principal.actorId);
    await audit(client, principal, 'payment.create', 'payment_intent', intent.rows[0].id, { caseId, amountMinor });
    return { ok: true, paymentIntent: intent.rows[0], amountMinor };
  });
}

async function capturePayment(env, principal, caseId, paymentId, body = {}) {
  requireRole(principal, ['admin']);
  return await tx(env, async (client) => {
    await requireCase(client, caseId);
    const intent = await client.query(`select * from payment_intents where id=$1 and case_id=$2 for update`, [paymentId, caseId]);
    if (!intent.rowCount) throw new Error('payment_not_found');
    if (!['created','requires_action','authorized'].includes(intent.rows[0].state)) throw new Error('payment_not_capturable');
    const updated = await client.query(`update payment_intents set state='captured',captured_at=now(),updated_at=now() where id=$1 returning *`, [paymentId]);
    await client.query(`insert into payment_events(payment_intent_id,event_type,amount,provider_event_id,payload) values($1,'captured',$2,$3,$4::jsonb)`, [paymentId, intent.rows[0].amount, body.providerEventId || null, JSON.stringify(body.payload || {})]);
    await client.query(
      `insert into ledger_entries(case_id,payment_intent_id,entry_type,account_code,amount,currency,state,metadata)
       values($1,$2,'payment_capture','customer_payment',$3,$4,'posted',$5::jsonb)`,
      [caseId, paymentId, intent.rows[0].amount, intent.rows[0].currency, JSON.stringify({ source: 'roviq-core-operations-v1' })]
    );
    await appendEvent(client, caseId, 'PAYMENT_CAPTURED', { paymentIntentId: paymentId, amount: intent.rows[0].amount, currency: intent.rows[0].currency }, principal.actorId);
    await audit(client, principal, 'payment.capture', 'payment_intent', paymentId, { caseId });
    return { ok: true, paymentIntent: updated.rows[0] };
  });
}

async function recoverException(env, principal, caseId, exceptionId, body = {}) {
  requireRole(principal, ['admin']);
  return await tx(env, async (client) => {
    await requireCase(client, caseId);
    const exception = await client.query(`select * from case_exceptions where id=$1 and case_id=$2 for update`, [exceptionId, caseId]);
    if (!exception.rowCount) throw new Error('exception_not_found');
    if (exception.rows[0].state !== 'open') return { ok: true, exception: exception.rows[0], alreadyResolved: true };

    if (body.recoveryType === 'mobility') {
      const recovered = await client.query(`select 1 from mobility_allocations where case_id=$1 and state in ('reserved','assigned','active','completed') limit 1`, [caseId]);
      if (!recovered.rowCount) throw new Error('recovery_condition_not_met');
    }
    if (body.recoveryType === 'parts') {
      const openParts = await client.query(`select 1 from parts_orders where case_id=$1 and status not in ('reserved','ordered','shipped','delivered','cancelled') limit 1`, [caseId]);
      if (openParts.rowCount) throw new Error('recovery_condition_not_met');
    }
    if (!String(body.resolution || '').trim()) throw new Error('resolution_required');
    const updated = await client.query(
      `update case_exceptions set state='resolved',resolved_at=now(),resolved_by_actor_id=$1,metadata=metadata || $2::jsonb where id=$3 returning *`,
      [principal.actorId || null, JSON.stringify({ resolution: String(body.resolution).trim(), recoveryType: body.recoveryType || 'manual' }), exceptionId]
    );
    await appendEvent(client, caseId, 'CASE_EXCEPTION_RESOLVED', { exceptionId, exceptionCode: exception.rows[0].exception_code, recoveryType: body.recoveryType || 'manual', resolution: String(body.resolution).trim() }, principal.actorId);
    await audit(client, principal, 'exception.resolve', 'case_exception', exceptionId, { caseId, recoveryType: body.recoveryType || 'manual' });
    return { ok: true, exception: updated.rows[0] };
  });
}

async function operationsOverview(env, principal, caseId) {
  return await withClient(env, async (client) => {
    const serviceCase = await requireCase(client, caseId);
    if (principal.role !== 'admin') await requireCustomerCaseAccess(client, principal, serviceCase);
    const [mobility, partsOrders, quoteRows, payments, exceptions] = await Promise.all([
      client.query(`select * from mobility_allocations where case_id=$1 order by created_at desc`, [caseId]),
      client.query(`select * from parts_orders where case_id=$1 order by created_at desc`, [caseId]),
      client.query(`select * from service_quotes where case_id=$1 order by revision desc`, [caseId]),
      client.query(`select id,case_id,customer_actor_id,provider,amount,currency,state,description,metadata,created_at,updated_at,authorized_at,captured_at,cancelled_at from payment_intents where case_id=$1 order by created_at desc`, [caseId]),
      client.query(`select * from case_exceptions where case_id=$1 order by created_at desc`, [caseId])
    ]);
    return { ok: true, caseId, mobility: mobility.rows, partsOrders: partsOrders.rows, quotes: quoteRows.rows, payments: payments.rows, exceptions: exceptions.rows };
  });
}

async function ensureE2EFixtures(client) {
  const domain = (await client.query(`select id from domains where code='maintenance' limit 1`)).rows[0];
  if (!domain) throw new Error('maintenance_domain_missing');
  let fleet = (await client.query(`select * from actors where actor_type='fleet' and attributes->>'fixture'='operations_e2e' limit 1`)).rows[0];
  if (!fleet) fleet = (await client.query(`insert into actors(domain_id,actor_type,attributes) values($1,'fleet',$2::jsonb) returning *`, [domain.id, JSON.stringify({ fixture: 'operations_e2e' })])).rows[0];
  let parts = (await client.query(`select * from actors where actor_type='parts' and attributes->>'fixture'='operations_e2e' limit 1`)).rows[0];
  if (!parts) parts = (await client.query(`insert into actors(domain_id,actor_type,attributes) values($1,'parts',$2::jsonb) returning *`, [domain.id, JSON.stringify({ fixture: 'operations_e2e' })])).rows[0];

  let resource = (await client.query(`select * from mobility_resources where actor_id=$1 and external_reference='operations-e2e-loaner' limit 1`, [fleet.id])).rows[0];
  if (!resource) resource = (await client.query(`insert into mobility_resources(actor_id,resource_type,external_reference,label,status,attributes) values($1,'loaner','operations-e2e-loaner','Operations E2E Loaner','available',$2::jsonb) returning *`, [fleet.id, JSON.stringify({ fixture: 'operations_e2e' })])).rows[0];
  else await client.query(`update mobility_resources set status='available',updated_at=now() where id=$1`, [resource.id]);

  let inventory = (await client.query(`select * from parts_inventory where supplier_actor_id=$1 and sku='ROVIQ-E2E-PART' and location_id is null limit 1`, [parts.id])).rows[0];
  if (!inventory) inventory = (await client.query(`insert into parts_inventory(supplier_actor_id,sku,part_number,description,quantity_on_hand,quantity_reserved,unit_price,currency,attributes) values($1,'ROVIQ-E2E-PART','E2E-001','Synthetic E2E service part',100,0,25.00,'USD',$2::jsonb) returning *`, [parts.id, JSON.stringify({ fixture: 'operations_e2e' })])).rows[0];
  else await client.query(`update parts_inventory set quantity_on_hand=greatest(quantity_on_hand,100),quantity_reserved=0,active=true,updated_at=now() where id=$1`, [inventory.id]);
  return { fleet, parts, resource, inventory };
}

async function operationsE2E(request, env, ctx) {
  requireInternalAuth(request, env);
  const baseRequest = new Request('https://internal/api/internal/e2e/production-core', {
    method: 'POST', headers: { authorization: request.headers.get('authorization') || '', 'content-type': 'application/json' }, body: '{}'
  });
  const baseResponse = await accessWorker.fetch(baseRequest, env, ctx);
  const base = await baseResponse.json();
  if (!baseResponse.ok || !base?.caseId) throw new Error(`production_e2e_failed:${base?.error || baseResponse.status}`);
  const caseId = base.caseId;
  const principal = { identityId: 'operations-e2e', role: 'admin', actorId: null };
  const fixtures = await withClient(env, ensureE2EFixtures);

  const mobility = await createMobilityAllocation(env, principal, caseId, { allocationType: 'loaner', notes: 'Operations E2E mobility check' });
  const parts = await createPartsOrder(env, principal, caseId, { supplierActorId: fixtures.parts.id, items: [{ sku: 'ROVIQ-E2E-PART', quantity: 1 }] });
  const quote = await createQuote(env, principal, caseId, {
    lines: [
      { lineType: 'labor', description: 'Synthetic coordinated service labor', quantity: 1, unitAmountMinor: 12500 },
      { lineType: 'part', description: 'Synthetic E2E service part', quantity: 1, unitAmountMinor: 2500, merchantActorId: fixtures.parts.id }
    ], taxMinor: 0, currency: 'USD'
  });
  const accepted = await acceptQuote(env, principal, caseId, quote.quote.id);
  const payment = await createPayment(env, principal, caseId, { quoteId: quote.quote.id, provider: 'manual', description: 'Operations E2E payment' });
  const captured = await capturePayment(env, principal, caseId, payment.paymentIntent.id, { providerEventId: `e2e-${crypto.randomUUID()}` });

  const exception = await withClient(env, async (client) => {
    const created = await client.query(`insert into case_exceptions(case_id,exception_code,severity,state,summary,metadata) values($1,'E2E_RECOVERY','warning','open','Synthetic recovery validation',$2::jsonb) returning *`, [caseId, JSON.stringify({ fixture: 'operations_e2e' })]);
    return created.rows[0];
  });
  const recovery = await recoverException(env, principal, caseId, exception.id, { resolution: 'Synthetic exception resolved after successful operations checks', recoveryType: 'manual' });
  const overview = await operationsOverview(env, principal, caseId);
  return { ok: true, caseId, base, mobility, parts, quote, accepted, payment, captured, recovery, overview };
}

function errorResponse(error) {
  const message = String(error?.message || error);
  if (message === 'unauthorized' || message === 'invalid_credentials') return json({ ok: false, error: message }, 401);
  if (message === 'forbidden') return json({ ok: false, error: message }, 403);
  if (['case_not_found','mobility_allocation_not_found','parts_order_not_found','quote_not_found','payment_not_found','exception_not_found'].includes(message)) return json({ ok: false, error: message }, 404);
  if (['content_type_must_be_application_json','parts_items_required','invalid_parts_items','quote_lines_required','invalid_quote_line','invalid_quote_total','invalid_payment_amount','invalid_mobility_state','invalid_parts_status','resolution_required'].includes(message)) return json({ ok: false, error: message }, 400);
  if (['quote_not_acceptible','quote_expired','quote_not_accepted','payment_not_capturable','recovery_condition_not_met'].includes(message)) return json({ ok: false, error: message }, 409);
  return json({ ok: false, error: message }, 503);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const mobilityMatch = url.pathname.match(/^\/api\/maintenance\/cases\/([0-9a-f-]+)\/mobility$/i);
    const mobilityUpdateMatch = url.pathname.match(/^\/api\/maintenance\/cases\/([0-9a-f-]+)\/mobility\/([0-9a-f-]+)$/i);
    const partsMatch = url.pathname.match(/^\/api\/maintenance\/cases\/([0-9a-f-]+)\/parts-orders$/i);
    const partsUpdateMatch = url.pathname.match(/^\/api\/maintenance\/cases\/([0-9a-f-]+)\/parts-orders\/([0-9a-f-]+)$/i);
    const quoteMatch = url.pathname.match(/^\/api\/maintenance\/cases\/([0-9a-f-]+)\/quotes$/i);
    const quoteAcceptMatch = url.pathname.match(/^\/api\/maintenance\/cases\/([0-9a-f-]+)\/quotes\/([0-9a-f-]+)\/accept$/i);
    const paymentMatch = url.pathname.match(/^\/api\/maintenance\/cases\/([0-9a-f-]+)\/payments$/i);
    const paymentCaptureMatch = url.pathname.match(/^\/api\/maintenance\/cases\/([0-9a-f-]+)\/payments\/([0-9a-f-]+)\/capture$/i);
    const recoveryMatch = url.pathname.match(/^\/api\/maintenance\/cases\/([0-9a-f-]+)\/exceptions\/([0-9a-f-]+)\/recover$/i);
    const overviewMatch = url.pathname.match(/^\/api\/maintenance\/cases\/([0-9a-f-]+)\/operations$/i);

    try {
      if (url.pathname === '/api/core/operations-capabilities' && request.method === 'GET') {
        return json({ ok: true, layer: 'operations-core-v1', capabilities: ['mobility_allocation','parts_fulfillment','quote_present_accept','payment_intent_capture','exception_resolution','operations_overview'] });
      }
      if (url.pathname === '/api/internal/e2e/operations' && request.method === 'POST') return json(await operationsE2E(request, env, ctx), 201);

      if (mobilityMatch && request.method === 'POST') {
        const principal = await principalFromRequest(request, env);
        return json(await createMobilityAllocation(env, principal, mobilityMatch[1], await readJson(request)), 201);
      }
      if (mobilityUpdateMatch && request.method === 'PATCH') {
        const principal = await principalFromRequest(request, env);
        return json(await updateMobilityAllocation(env, principal, mobilityUpdateMatch[1], mobilityUpdateMatch[2], await readJson(request)));
      }
      if (partsMatch && request.method === 'POST') {
        const principal = await principalFromRequest(request, env);
        return json(await createPartsOrder(env, principal, partsMatch[1], await readJson(request)), 201);
      }
      if (partsUpdateMatch && request.method === 'PATCH') {
        const principal = await principalFromRequest(request, env);
        return json(await updatePartsOrder(env, principal, partsUpdateMatch[1], partsUpdateMatch[2], await readJson(request)));
      }
      if (quoteMatch && request.method === 'POST') {
        const principal = await principalFromRequest(request, env);
        return json(await createQuote(env, principal, quoteMatch[1], await readJson(request)), 201);
      }
      if (quoteAcceptMatch && request.method === 'POST') {
        const principal = await principalFromRequest(request, env);
        return json(await acceptQuote(env, principal, quoteAcceptMatch[1], quoteAcceptMatch[2]));
      }
      if (paymentMatch && request.method === 'POST') {
        const principal = await principalFromRequest(request, env);
        return json(await createPayment(env, principal, paymentMatch[1], await readJson(request)), 201);
      }
      if (paymentCaptureMatch && request.method === 'POST') {
        const principal = await principalFromRequest(request, env);
        return json(await capturePayment(env, principal, paymentCaptureMatch[1], paymentCaptureMatch[2], await readJson(request)));
      }
      if (recoveryMatch && request.method === 'POST') {
        const principal = await principalFromRequest(request, env);
        return json(await recoverException(env, principal, recoveryMatch[1], recoveryMatch[2], await readJson(request)));
      }
      if (overviewMatch && request.method === 'GET') {
        const principal = await principalFromRequest(request, env);
        return json(await operationsOverview(env, principal, overviewMatch[1]));
      }
    } catch (error) { return errorResponse(error); }

    return await accessWorker.fetch(request, env, ctx);
  }
};