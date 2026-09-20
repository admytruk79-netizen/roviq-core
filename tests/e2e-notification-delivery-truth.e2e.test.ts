import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { getNotificationDeliverySummary, requeueFailedNotification } from '../src/services/notifications.js';

const admin={role:'admin'} as const;

async function createNotification(channel:string){
  const created=await pool.query(
    `insert into notification_outbox(channel,recipient_type,recipient_id,template_key,payload)
     values($1,'actor',$2,'delivery_truth_test','{}'::jsonb) returning *`,
    [channel,crypto.randomUUID()]
  );
  return created.rows[0];
}

describe('notification delivery operational truth',()=>{
  afterAll(async()=>{ await pool.end(); });

  it('distinguishes queued, retrying, delivered and failed notifications',async()=>{
    const queued=await createNotification('push');
    const retrying=await createNotification('push');
    const delivered=await createNotification('push');
    const failed=await createNotification('push');

    await pool.query(`update notification_outbox set attempt_count=2,state='pending' where id=$1`,[retrying.id]);
    await pool.query(`update notification_outbox set attempt_count=1,state='sent',sent_at=now() where id=$1`,[delivered.id]);
    await pool.query(`update notification_outbox set attempt_count=5,max_attempts=5,state='dead',last_error='provider_down' where id=$1`,[failed.id]);

    const summary=await getNotificationDeliverySummary();
    expect(summary.states.queued).toBeGreaterThanOrEqual(1);
    expect(summary.states.retrying).toBeGreaterThanOrEqual(1);
    expect(summary.states.delivered).toBeGreaterThanOrEqual(1);
    expect(summary.states.failed).toBeGreaterThanOrEqual(1);
    expect(summary.failures.some((row:any)=>row.id===failed.id&&row.last_error==='provider_down')).toBe(true);

    await pool.query(`delete from notification_outbox where id=any($1::uuid[])`,[[queued.id,retrying.id,delivered.id,failed.id]]);
  });

  it('requeues a dead notification without erasing delivery-attempt history',async()=>{
    const failed=await createNotification('push');
    await pool.query(`update notification_outbox set attempt_count=5,max_attempts=5,state='dead',last_error='provider_down' where id=$1`,[failed.id]);
    await pool.query(
      `insert into notification_delivery_attempts(notification_id,attempt_number,provider,state,error_code,error_message)
       values($1,5,'webpush','failed','provider_down','provider unavailable')`,
      [failed.id]
    );

    const recovered=await requeueFailedNotification(admin,failed.id);
    expect(recovered.state).toBe('pending');
    expect(Number(recovered.attempt_count)).toBe(5);
    expect(Number(recovered.max_attempts)).toBeGreaterThanOrEqual(8);
    expect(recovered.last_error).toBeNull();

    const history=await pool.query(
      `select attempt_number,state,error_code from notification_delivery_attempts where notification_id=$1 order by attempt_number`,
      [failed.id]
    );
    expect(history.rows).toEqual([{attempt_number:5,state:'failed',error_code:'provider_down'}]);

    await pool.query(`delete from notification_outbox where id=$1`,[failed.id]);
  });

  it('refuses manual retry for a notification that is not failed',async()=>{
    const queued=await createNotification('push');
    await expect(requeueFailedNotification(admin,queued.id)).rejects.toMatchObject({message:'notification_not_failed',statusCode:409});
    await pool.query(`delete from notification_outbox where id=$1`,[queued.id]);
  });
});
