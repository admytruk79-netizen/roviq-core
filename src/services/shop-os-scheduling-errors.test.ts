import { describe, expect, it } from 'vitest';
import { rethrowSchedulingError } from './shop-os-scheduling-errors.js';

function mapped(error:Error&{code?:string;constraint?:string}){
  try{
    rethrowSchedulingError(error);
  }catch(result){
    return result as Error&{statusCode?:number};
  }
  throw new Error('expected scheduling error');
}

describe('Shop OS scheduling database error mapping',()=>{
  it.each([
    ['recovery_source_cannot_reference_self','recovery_source_cannot_reference_self'],
    ['recovery_root_has_children','recovery_root_has_children'],
    ['recovery_source_must_be_root','shop_os_recovery_source_not_root']
  ])('maps %s to a stable 409 domain error',(databaseMessage,domainMessage)=>{
    const source=Object.assign(new Error(databaseMessage),{code:'P0001'});
    const result=mapped(source);
    expect(result.message).toBe(domainMessage);
    expect(result.statusCode).toBe(409);
  });

  it('maps a missing recovery source to 404',()=>{
    const source=Object.assign(new Error('recovery_source_appointment_not_found'),{code:'23503'});
    const result=mapped(source);
    expect(result.message).toBe('recovery_source_appointment_not_found');
    expect(result.statusCode).toBe(404);
  });
});
