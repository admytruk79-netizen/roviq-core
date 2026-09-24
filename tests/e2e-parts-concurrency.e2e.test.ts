import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { assignSupplier, createPartsOrder, markPartsOrderStatus, reserveOrderInventory, upsertInventory } from '../src/services/parts.js';

const admin={role:'admin'} as const;

describe('parts order concurrency',()=>{
  afterAll(async()=>{await pool.end();});

  it('serializes concurrent delivery so inventory is settled exactly once',async()=>{
    const domain=await pool.query(`select id from domains where code='maintenance' limit 1`);
    const serviceCase=await pool.query(
      `insert into service_cases(domain_id,case_type,state)
       values($1,'maintenance','provider_selection') returning id`,
      [domain.rows[0].id]
    );
    const supplier=await pool.query(
      `insert into actors(actor_type,status) values('parts','active') returning id`
    );
    const sku=`CONCURRENT-DELIVERY-${Date.now()}-${Math.random()}`;
    const created=await createPartsOrder(admin,{
      caseId:serviceCase.rows[0].id,
      items:[{sku,quantity:2}]
    });
    const orderId=created!.order.id as string;
    await assignSupplier(admin,orderId,supplier.rows[0].id);
    await upsertInventory(admin,{
      supplierActorId:supplier.rows[0].id,
      sku,
      quantityOnHand:5,
      unitPrice:10
    });
    await reserveOrderInventory(admin,orderId);
    await markPartsOrderStatus(admin,orderId,'ordered');

    const results=await Promise.allSettled([
      markPartsOrderStatus(admin,orderId,'delivered',{source:'concurrency-a'}),
      markPartsOrderStatus(admin,orderId,'delivered',{source:'concurrency-b'})
    ]);
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    const rejected=results.find(result=>result.status==='rejected');
    expect(rejected?.status).toBe('rejected');
    if(rejected?.status==='rejected') expect(rejected.reason?.message).toBe('invalid_parts_transition');

    const inventory=await pool.query(
      `select quantity_on_hand,quantity_reserved
         from parts_inventory
        where supplier_actor_id=$1 and sku=$2`,
      [supplier.rows[0].id,sku]
    );
    expect(Number(inventory.rows[0].quantity_on_hand)).toBe(3);
    expect(Number(inventory.rows[0].quantity_reserved)).toBe(0);

    const order=await pool.query(`select status from parts_orders where id=$1`,[orderId]);
    expect(order.rows[0].status).toBe('delivered');

    const deliveredItems=await pool.query(
      `select count(*)::int as n from parts_order_items
        where order_id=$1 and status='delivered'`,
      [orderId]
    );
    expect(Number(deliveredItems.rows[0].n)).toBe(1);
  });
});
