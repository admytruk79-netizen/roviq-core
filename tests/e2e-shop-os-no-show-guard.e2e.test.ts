import {afterAll,describe,expect,it} from 'vitest';
import {pool} from '../src/db/pool.js';

describe('Shop OS no-show timing guard',()=>{
  afterAll(async()=>{await pool.end();});

  it('rejects marking an appointment no-show before its scheduled start',async()=>{
    const appointment=await pool.query(`
      insert into roviq_appointments(appointment_status,starts_at,ends_at,service_category)
      values('held',now()+interval '30 minutes',now()+interval '90 minutes','repair')
      returning id`);

    await expect(pool.query(`
      update roviq_appointments set appointment_status='no_show',updated_at=now() where id=$1
    `,[appointment.rows[0].id])).rejects.toMatchObject({message:'appointment_no_show_before_start'});

    const current=await pool.query(`select appointment_status from roviq_appointments where id=$1`,[appointment.rows[0].id]);
    expect(current.rows[0].appointment_status).toBe('held');
  });

  it('allows no-show once the scheduled start has been reached',async()=>{
    const appointment=await pool.query(`
      insert into roviq_appointments(appointment_status,starts_at,ends_at,service_category)
      values('held',now()-interval '30 minutes',now()+interval '30 minutes','repair')
      returning id`);

    const updated=await pool.query(`
      update roviq_appointments set appointment_status='no_show',updated_at=now() where id=$1
      returning appointment_status
    `,[appointment.rows[0].id]);
    expect(updated.rows[0].appointment_status).toBe('no_show');
  });
});
