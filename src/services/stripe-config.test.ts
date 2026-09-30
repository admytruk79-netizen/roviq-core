import { describe, expect, it } from 'vitest';
import { cleanStripeSecret, stripeKeyShape } from './stripe-config.js';

describe('Stripe secret key cleanup', () => {
  const key = 'sk_test_51AbcDEF123';

  it('keeps a clean key as is', () => {
    expect(cleanStripeSecret(key)).toBe(key);
  });

  it('removes what pasting on a phone adds', () => {
    expect(cleanStripeSecret(`  ${key}\n`)).toBe(key);
    expect(cleanStripeSecret(`\u200B${key}\uFEFF`)).toBe(key);
    expect(cleanStripeSecret(`"${key}"`)).toBe(key);
    expect(cleanStripeSecret(`STRIPE_SECRET_KEY=${key}`)).toBe(key);
    expect(cleanStripeSecret(`Bearer ${key}`)).toBe(key);
    expect(cleanStripeSecret(`Secret key\t${key}`)).toBe(key);
    expect(cleanStripeSecret(`s\u00A0${key}`)).toBe(key);
  });

  it('accepts restricted keys and reports what kind of key is stored', () => {
    expect(cleanStripeSecret(' rk_live_9xyz ')).toBe('rk_live_9xyz');
    expect(stripeKeyShape(key)).toBe('secret_test');
    expect(stripeKeyShape('rk_live_9xyz')).toBe('restricted_live');
    expect(stripeKeyShape('pk_test_123')).toBe('publishable');
    expect(stripeKeyShape('mk_123')).toBe('unrecognized');
    expect(stripeKeyShape(cleanStripeSecret('   '))).toBeNull();
  });
});
