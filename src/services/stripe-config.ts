// Reads the Stripe secret key from the environment, tolerating what pasting on a phone can add:
// surrounding whitespace, invisible characters, quotes, a "NAME=" or "Bearer " prefix, or the row
// label copied along with the key. If a Stripe secret or restricted key appears anywhere in the
// value, that key is used.

const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/g;
const SECRET_KEY = /\b(?:sk|rk)_(?:test|live)_[A-Za-z0-9]+/;

export function cleanStripeSecret(raw: string | undefined): string | null {
  if (!raw) return null;
  const value = raw.replace(INVISIBLE, '').replace(/\u00A0/g, ' ').trim();
  const match = value.match(SECRET_KEY);
  if (match) return match[0];
  const stripped = value
    .replace(/^STRIPE_SECRET_KEY\s*=\s*/i, '')
    .replace(/^Bearer\s+/i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
  return stripped || null;
}

export function stripeSecretKey(): string | null {
  return cleanStripeSecret(process.env.STRIPE_SECRET_KEY);
}

export type StripeKeyShape = 'secret_test' | 'secret_live' | 'restricted_test' | 'restricted_live' | 'publishable' | 'unrecognized';

// Describes what kind of value is stored, never the value itself.
export function stripeKeyShape(key: string | null): StripeKeyShape | null {
  if (!key) return null;
  const m = key.match(/^(sk|rk|pk)_(test|live)_/);
  if (!m) return 'unrecognized';
  if (m[1] === 'pk') return 'publishable';
  return `${m[1] === 'sk' ? 'secret' : 'restricted'}_${m[2]}` as StripeKeyShape;
}

// What the stored value starts with (up to the first underscore) and how long it is. Neither reveals
// the key, but together they tell a mis-paste apart: a key ID (mk_), the publishable key (pk_),
// a webhook secret (whsec_), or a cut-off key.
export function stripeKeyHint(key: string | null): { prefix: string | null; length: number } | null {
  if (!key) return null;
  const prefix = key.match(/^[A-Za-z]{2,6}_/)?.[0] ?? null;
  return { prefix, length: key.length };
}
