import {afterAll,describe,expect,it} from 'vitest';
import {pool} from '../src/db/pool.js';
import {createShopWaitlistEntry,updateShopWaitlistEntry} from '../src/services/shop-os-waitlist.js';

async function setupShop(){
  const org=await pool.query(`insert into organizations(organization_type,display_name) values('shop',$1) returning id`,[
    `Shop OS Waitlist Clock ${Date.now()}-${Math.random()}`
  ]);
  await pool.query(`insert into partner_system_connections(
      organization_id,mode,provider_key,display_name,connection_status
    ) values($1,'roviq_native','roviq','Shop OS Native','active')`,[org.rows[0].id]);
  const actor=await pool.query(`insert into actors(actor_type,status,organization_id) values('shop','active',$1) returning id`,[org.rows[0].id]);
  return {actorId:actor.rows[0].id as string};
}

describe('Shop OS waitlist offer wall clock',()=>{
  afterAll(async()=>{await pool.end();});

  it('starts the promised 30-minute window after a row-lock wait, not at transaction start',async()=>{
    const shop=await setupShop();
    const partner={role:'partner',actorId:shop.actorId} as const;
    const entry=await createShopWaitlistEntry(partner,{requestedServiceCategory:'repair'});

    const blocker=await pool.connect();
    await blocker.query('begin');
    await blocker.query(`select id from shop_waitlist_entries where id=$1 for update`,[entry.id]);

    const offerPromise=updateShopWaitlistEntry(partner,entry.id,{action:'offer'});
    await new Promise(resolve=>setTimeout(resolve,2500));
    const releasedAt=Date.now();
    await blocker.query('commit');
    blocker.release();

    const offered=await offerPromise;
    const expiryMs=new Date(offered.offer_expires_at).getTime();
    expect(expiryMs-releasedAt).toBeGreaterThanOrEqual(29*60_000+59_000);
    expect(expiryMs-releasedAt).toBeLessThanOrEqual(30*60_000+5_000);
  });
});