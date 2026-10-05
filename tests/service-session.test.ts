import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deepLink, restoreSession, signIn, signOut } from '../service/src/session';

// One expiry for the whole file: a token built a second later must still equal the one stored.
const EXP = Math.floor(Date.now() / 1000) + 3600;
const jwt = (role: string) => `header.${btoa(JSON.stringify({ role, exp: EXP }))}.signature`;
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); }
  });
});

describe('unified app role tabs', () => {
  it('opens Customer and a granted Parts tab with separate scoped tokens', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/api/auth/login')) return response({
        accessToken: jwt('customer'), principal: { role: 'customer', actorId: 'customer-1' },
        roles: [{ role: 'customer', actorId: 'customer-1' }, { role: 'parts', actorId: 'parts-1' }]
      });
      if (url.endsWith('/api/auth/switch-role')) return response({
        accessToken: jwt('parts'), principal: { role: 'parts', actorId: 'parts-1' }
      });
      throw new Error(`unexpected request: ${url}`);
    }));
    const session = await signIn('person@example.com', 'password123');
    expect(session.roles).toEqual(['customer', 'parts']);
    expect(localStorage.getItem('roviq_access_token')).toBe(jwt('customer'));
    expect(localStorage.getItem('roviq_parts_token')).toBe(jwt('parts'));
    expect(localStorage.getItem('roviq_ops_token')).toBeNull();
    expect(restoreSession()?.roles).toEqual(['customer', 'parts']);
    signOut();
    expect(restoreSession()).toBeNull();
  });

  it('uses the admin token only for Ops and test identities for other tabs', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/api/auth/login')) return response({
        accessToken: jwt('admin'), principal: { role: 'admin', actorId: null }
      });
      const role = url.match(/\/api\/admin\/testing\/([a-z]+)-session$/)?.[1];
      if (role) return response({ accessToken: jwt(role), principal: { role, actorId: `${role}-test` } });
      throw new Error(`unexpected request: ${url}`);
    }));
    const session = await signIn('ops@example.com', 'password123');
    expect(session.roles).toEqual(['customer', 'diagnostic', 'tow', 'partner', 'parts', 'fleet', 'admin']);
    expect(session.testMode).toBe(true);
    expect(localStorage.getItem('roviq_ops_token')).toBe(jwt('admin'));
    expect(JSON.parse(localStorage.getItem('roviq_principal') ?? '{}').role).toBe('customer');
    expect(restoreSession()?.roles).toEqual(session.roles);
  });
});

describe('unified app deep links', () => {
  const session = { roles: ['customer', 'tow'] as const, testMode: false, email: 'a@b.c' } as unknown as Parameters<typeof deepLink>[1];
  const stripeReturn = '?open=customer&at=%2Fcases%2F11111111-2222-3333-4444-555555555555%3Fpayment%3Dsuccess%26payment_id%3D66666666-7777-8888-9999-000000000000%26session_id%3Dcs_test_a1B2';

  it('reopens a held tab at the page Stripe returns to', () => {
    expect(deepLink(stripeReturn, session)).toEqual({
      role: 'customer',
      route: '/cases/11111111-2222-3333-4444-555555555555?payment=success&payment_id=66666666-7777-8888-9999-000000000000&session_id=cs_test_a1B2'
    });
  });

  it('ignores tabs the session does not hold and anything that is not an in-app route', () => {
    expect(deepLink('?open=admin&at=%2Fcases%2Fx', session)).toBeNull();
    expect(deepLink('?open=customer&at=https%3A%2F%2Fevil.example', session)).toBeNull();
    expect(deepLink('?open=customer&at=%2F%2Fevil.example', session)).toBeNull();
    expect(deepLink('?open=customer&at=%2Fcases%2F%3Cscript%3E', session)).toBeNull();
    expect(deepLink('', session)).toBeNull();
  });
});

