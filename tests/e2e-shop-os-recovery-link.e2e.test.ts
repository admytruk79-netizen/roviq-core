import {afterAll,describe,expect,it} from 'vitest';
import {pool} from '../src/db/pool.js';

describe('Shop OS appointment recovery link',()=>{
  afterAll(async()=>{await pool.end();});

  it('allows only one active replacement for a terminal source',async()=>{
    const source=await pool.query(`
      insert into roviq_appointments(appointment_status,starts_at,ends_at,service_category)
      values('cancelled',now()-interval '2 hours',now()-interval '1 hour','repair')
      returning id`);

    const first=await pool.query(`
      insert into roviq_appointments(appointment_status,starts_at,ends_at,service_category,recovery_source_appointment_id)
      values('held',now()+interval '1 hour',now()+interval '2 hours','repair',$1)
      returning id,recovery_source_appointment_id`,[source.rows[0].id]);
    expect(first.rows[0].recovery_source_appointment_id).toBe(source.rows[0].id);

    await expect(pool.query(`
      insert into roviq_appointments(appointment_status,starts_at,ends_at,service_category,recovery_source_appointment_id)
      values('held',now()+interval '3 hours',now()+interval '4 hours','repair',$1)
    `,[source.rows[0].id])).rejects.toMatchObject({code:'23505'});

    await pool.query(`update roviq_appointments set appointment_status='cancelled' where id=$1`,[first.rows[0].id]);
    const retry=await pool.query(`
      insert into roviq_appointments(appointment_status,starts_at,ends_at,service_category,recovery_source_appointment_id)
      values('held',now()+interval '3 hours',now()+interval '4 hours','repair',$1)
      returning id`,[source.rows[0].id]);
    expect(retry.rowCount).toBe(1);
  });
});
