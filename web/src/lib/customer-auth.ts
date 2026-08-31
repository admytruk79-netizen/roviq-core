import type { Principal } from './types';

type SessionResponse = { accessToken: string; principal: Principal };

type CustomerAuthDeps = {
  post: <T>(path: string, payload?: unknown) => Promise<T>;
  setToken: (token: string | null) => void;
};

export async function authenticateCustomer(
  email: string,
  password: string,
  deps: CustomerAuthDeps
): Promise<SessionResponse> {
  deps.setToken(null);

  try {
    const result = await deps.post<SessionResponse>('/api/auth/login', {
      email: email.trim(),
      password
    });

    let session = result;
    if (result.principal.role === 'admin') {
      deps.setToken(result.accessToken);
      session = await deps.post<SessionResponse>('/api/admin/testing/customer-session', {});
    }

    if (session.principal.role !== 'customer' || !session.principal.actorId) {
      throw new Error('This portal requires a customer account.');
    }

    deps.setToken(session.accessToken);
    return session;
  } catch (error) {
    deps.setToken(null);
    throw error;
  }
}
