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
  it('clears prepared tokens when a later role handoff fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/api/auth/login')) return response({
        accessToken: jwt('customer'), principal: { role: 'customer', actorId: 'customer-1' },
        roles: [{ role: 'customer' }, { role: 'parts' }]
      });
      return new Response(JSON.stringify({ error: 'role_revoked' }), { status: 403 });
    }));
    await expect(signIn('person@example.com', 'password123')).rejects.toThrow('role_revoked');
    expect(localStorage.getItem('roviq_access_token')).toBeNull();
    expect(localStorage.getItem('roviq_parts_token')).toBeNull();
    expect(restoreSession()).toBeNull();
  });

  it('rejects a role handoff with an unexpected principal', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/api/auth/login')) return response({
        accessToken: jwt('customer'), principal: { role: 'customer', actorId: 'customer-1' },
        roles: [{ role: 'customer' }, { role: 'parts' }]
      });
      return response({ accessToken: jwt('admin'), principal: { role: 'admin' } });
    }));
    await expect(signIn('person@example.com', 'password123')).rejects.toThrow('invalid_workspace_session');
    expect(localStorage.getItem('roviq_access_token')).toBeNull();
    expect(localStorage.getItem('roviq_parts_token')).toBeNull();
  });

  it('opens only the granted Actor tab for an identity whose primary role is Customer', async () => {
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
    expect(session.roles).toEqual(['parts']);
    expect(localStorage.getItem('roviq_access_token')).toBeNull();
    expect(localStorage.getItem('roviq_parts_token')).toBe(jwt('parts'));
    expect(localStorage.getItem('roviq_ops_token')).toBeNull();
    expect(restoreSession()?.roles).toEqual(['parts']);
    signOut();
    expect(restoreSession()).toBeNull();
  });

  it('opens only Ops for admin without creating test identities', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/api/auth/login')) return response({
        accessToken: jwt('admin'), principal: { role: 'admin', actorId: null }
      });
      const role = url.match(/\/api\/admin\/testing\/([a-z]+)-session$/)?.[1];
      if (role) return response({ accessToken: jwt(role), principal: { role, actorId: `${role}-test` } });
      throw new Error(`unexpected request: ${url}`);
    }));
    const session = await signIn('ops@example.com', 'password123');
    expect(session.roles).toEqual(['admin']);
    expect(session.testMode).toBe(false);
    expect(localStorage.getItem('roviq_ops_token')).toBe(jwt('admin'));
    expect(localStorage.getItem('roviq_principal')).toBeNull();
    expect(restoreSession()?.roles).toEqual(session.roles);
  });
});

describe('unified app deep links', () => {
  const session = { roles: ['tow'] as const, testMode: false, email: 'a@b.c' } as unknown as Parameters<typeof deepLink>[1];
  const stripeReturn = '?open=customer&at=%2Fcases%2F11111111-2222-3333-4444-555555555555%3Fpayment%3Dsuccess%26payment_id%3D66666666-7777-8888-9999-000000000000%26session_id%3Dcs_test_a1B2';

  it('does not reopen Customer inside Actor', () => {
    expect(deepLink(stripeReturn, session)).toBeNull();
  });

  it('ignores tabs the session does not hold and anything that is not an in-app route', () => {
    expect(deepLink('?open=admin&at=%2Fcases%2Fx', session)).toBeNull();
    expect(deepLink('?open=customer&at=https%3A%2F%2Fevil.example', session)).toBeNull();
    expect(deepLink('?open=customer&at=%2F%2Fevil.example', session)).toBeNull();
    expect(deepLink('?open=customer&at=%2Fcases%2F%3Cscript%3E', session)).toBeNull();
    expect(deepLink('', session)).toBeNull();
  });
});
