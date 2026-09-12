import { describe, expect, it } from 'vitest';
import type { Principal } from '../types/principal.js';
import { listShopOsBoard } from './shop-os-board.js';

describe('Shop OS board range guard',()=>{
  it('rejects pathological ranges before querying board data',async()=>{
    await expect(listShopOsBoard({} as Principal,{
      from:'2026-09-11T00:00:00.000Z',
      to:'9999-12-31T00:00:00.000Z'
    })).rejects.toMatchObject({message:'shop_os_board_range_too_large',statusCode:400});
  });
});
