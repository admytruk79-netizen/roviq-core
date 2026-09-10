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

  it('rejects a direct future no-show insert',async()=>{
    await expect(pool.query(`
      insert into roviq_appointments(appointment_status,starts_at,ends_at,service_category)
      values('no_show',now()+interval '30 minutes',now()+interval '90 minutes','repair')
    `)).rejects.toMatchObject({message:'appointment_no_show_before_start'});
  });

  it('rejects moving an existing no-show before its new scheduled start',async()=>{
    const appointment=await pool.query(`
      insert into roviq_appointments(appointment_status,starts_at,ends_at,service_category)
      values('held',now()-interval '60 minutes',now()-interval '30 minutes','repair')
      returning id`);
    await pool.query(`update roviq_appointments set appointment_status='no_show' where id=$1`,[appointment.rows[0].id]);

    await expect(pool.query(`
      update roviq_appointments
         set starts_at=now()+interval '30 minutes',ends_at=now()+interval '90 minutes',updated_at=now()
       where id=$1
    `,[appointment.rows[0].id])).rejects.toMatchObject({message:'appointment_no_show_before_start'});
  });

  it('uses wall-clock time inside a long transaction once the appointment becomes due',async()=>{
    const client=await pool.connect();
    try{
      await client.query('begin');
      const appointment=await client.query(`
        insert into roviq_appointments(appointment_status,starts_at,ends_at,service_category)
        values('held',clock_timestamp()+interval '150 milliseconds',clock_timestamp()+interval '60 minutes','repair')
        returning id`);
      await client.query(`select pg_sleep(0.2)`);
      const updated=await client.query(`
        update roviq_appointments set appointment_status='no_show',updated_at=clock_timestamp() where id=$1
        returning appointment_status
      `,[appointment.rows[0].id]);
      expect(updated.rows[0].appointment_status).toBe('no_show');
      await client.query('commit');
    }catch(error){await client.query('rollback');throw error;}finally{client.release();}
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
