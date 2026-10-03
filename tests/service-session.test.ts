import { beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreSession, signIn, signOut } from '../service/src/session';

const jwt = (role: string) => `header.${btoa(JSON.stringify({ role, exp: Math.floor(Date.now() / 1000) + 3600 }))}.signature`;
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
