import { describe, expect, it } from 'vitest';
import { normalizeSslMode } from './pool.js';

describe('database sslmode', () => {
  it('names the mode pg already uses, so it stops warning', () => {
    expect(normalizeSslMode('postgresql://u:p@h/db?sslmode=require')).toBe('postgresql://u:p@h/db?sslmode=verify-full');
    expect(normalizeSslMode('postgresql://u:p@h/db?sslmode=require&channel_binding=require')).toBe('postgresql://u:p@h/db?sslmode=verify-full&channel_binding=require');
    expect(normalizeSslMode('postgresql://u:p@h/db?channel_binding=require&sslmode=prefer')).toBe('postgresql://u:p@h/db?channel_binding=require&sslmode=verify-full');
  });

  it('leaves other settings alone', () => {
    expect(normalizeSslMode('postgresql://u:p@h/db')).toBe('postgresql://u:p@h/db');
    expect(normalizeSslMode('postgresql://u:p@h/db?sslmode=disable')).toBe('postgresql://u:p@h/db?sslmode=disable');
    expect(normalizeSslMode('postgresql://u:p@h/db?sslmode=verify-full')).toBe('postgresql://u:p@h/db?sslmode=verify-full');
  });
});
