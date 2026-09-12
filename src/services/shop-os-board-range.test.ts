import { describe, expect, it } from 'vitest';
import { normalizeShopOsBoardRange } from './shop-os-board.js';

describe('Shop OS board range guard',()=>{
  it('normalizes pathological ranges to a bounded query window',()=>{
    const range=normalizeShopOsBoardRange('2026-09-11T00:00:00.000Z','9999-12-31T00:00:00.000Z');
    expect(range.truncated).toBe(true);
    expect(new Date(range.to).getTime()-new Date(range.from).getTime()).toBeLessThanOrEqual(366*24*60*60*1000);
    expect(range.to).toBe('9999-12-31T00:00:00.000Z');
  });

  it('preserves already bounded ranges',()=>{
    const range=normalizeShopOsBoardRange('2026-09-11T00:00:00.000Z','2026-10-11T00:00:00.000Z');
    expect(range).toEqual({from:'2026-09-11T00:00:00.000Z',to:'2026-10-11T00:00:00.000Z',truncated:false});
  });
});
