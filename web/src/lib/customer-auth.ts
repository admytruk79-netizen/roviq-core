import type { Principal } from './types';

type SessionResponse = { accessToken: string; principal: Principal; roles?: Principal[] };

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
    if (result.principal.role !== 'customer' && result.roles?.some(role => role.role === 'customer')) {
      deps.setToken(result.accessToken);
      session = await deps.post<SessionResponse>('/api/auth/switch-role', { role: 'customer' });
    }

    if (session.principal.role !== 'customer' || !session.principal.actorId) {
      throw new Error('Use ROVIQ Actor for team work. This app requires a granted customer account.');
    }

    deps.setToken(session.accessToken);
    return session;
  } catch (error) {
    deps.setToken(null);
    throw error;
  }
}
