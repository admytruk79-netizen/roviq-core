const BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';
const TOKEN_KEY = 'roviq_partner_token';
export const SESSION_EXPIRED_EVENT = 'roviq:session-expired';

function tokenExpired(token: string) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number };
    return typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now();
  } catch {
    return false;
  }
}

function expireSession() {
  localStorage.removeItem(TOKEN_KEY);
  window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
}

export function getToken() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token && tokenExpired(token)) {
    expireSession();
    return null;
  }
  return token;
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const options: RequestInit = {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {})
    }
  };
  const method = (init.method ?? 'GET').toUpperCase();
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, options);
    if (method === 'GET' && [502, 503, 504].includes(response.status)) {
      await new Promise(resolve => setTimeout(resolve, 350));
      response = await fetch(`${BASE_URL}${path}`, options);
    }
  } catch (error) {
    if (method !== 'GET') throw error;
    await new Promise(resolve => setTimeout(resolve, 350));
    response = await fetch(`${BASE_URL}${path}`, options);
  }

  if (response.status === 401 && token) {
    expireSession();
    throw new Error('Your session expired. Please sign in again.');
  }
  if (!response.ok) {
    let message = `request_failed_${response.status}`;
    try {
      const body = await response.json() as { error?: string };
      if (body.error) message = body.error;
    } catch {}
    throw new Error(message);
  }

  return response.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) })
};
