import { describe, expect, it, vi } from 'vitest';
import { authenticateCustomer } from '../web/src/lib/customer-auth';

describe('Customer portal authentication handoff', () => {
  it('exchanges an admin login for a customer-scoped session before finishing login', async () => {
    let token: string | null = 'stale-token';
    const calls: Array<{ path: string; payload: unknown; token: string | null }> = [];

    const post = vi.fn(async <T>(path: string, payload?: unknown): Promise<T> => {
      calls.push({ path, payload, token });
      if (path === '/api/auth/login') {
        return {
          accessToken: 'admin-token',
          principal: { role: 'admin', actorId: null }
        } as T;
      }
      if (path === '/api/admin/testing/customer-session') {
        expect(token).toBe('admin-token');
        return {
          accessToken: 'customer-token',
          principal: { role: 'customer', actorId: 'customer-actor' }
        } as T;
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    const session = await authenticateCustomer('  admin@example.com  ', 'password', {
      post,
      setToken: value => { token = value; }
    });

    expect(calls.map(call => call.path)).toEqual([
      '/api/auth/login',
      '/api/admin/testing/customer-session'
    ]);
    expect(calls[0].payload).toEqual({ email: 'admin@example.com', password: 'password' });
    expect(calls[0].token).toBeNull();
    expect(session.principal).toEqual({ role: 'customer', actorId: 'customer-actor' });
    expect(token).toBe('customer-token');
  });

  it('accepts a direct customer login without calling the admin handoff route', async () => {
    let token: string | null = null;
    const post = vi.fn(async <T>(): Promise<T> => ({
      accessToken: 'customer-token',
      principal: { role: 'customer', actorId: 'customer-actor' }
    }) as T);

    await authenticateCustomer('customer@example.com', 'password', {
      post,
      setToken: value => { token = value; }
    });

    expect(post).toHaveBeenCalledTimes(1);
    expect(token).toBe('customer-token');
  });

  it('clears any temporary bearer token when the customer handoff fails', async () => {
    let token: string | null = 'stale-token';
    const post = vi.fn(async <T>(path: string): Promise<T> => {
      if (path === '/api/auth/login') {
        return {
          accessToken: 'admin-token',
          principal: { role: 'admin', actorId: null }
        } as T;
      }
      throw new Error('handoff failed');
    });

    await expect(authenticateCustomer('admin@example.com', 'password', {
      post,
      setToken: value => { token = value; }
    })).rejects.toThrow('handoff failed');

    expect(token).toBeNull();
  });
});
