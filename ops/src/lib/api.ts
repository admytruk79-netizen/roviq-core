const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';
const TOKEN_KEY = 'roviq_access_token';
export const SESSION_EXPIRED_EVENT = 'roviq:session-expired';

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    const message = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : `Request failed with status ${status}`;
    super(message);
    this.status = status;
    this.body = body;
  }
}

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

async function doFetch(path: string, options: RequestInit, headers: Headers) {
  return fetch(`${API_BASE}${path}`, { ...options, headers });
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const method = (options.method ?? 'GET').toUpperCase();
  let res: Response;
  try {
    res = await doFetch(path, options, headers);
    if (method === 'GET' && [502, 503, 504].includes(res.status)) {
      await new Promise(resolve => setTimeout(resolve, 350));
      res = await doFetch(path, options, headers);
    }
  } catch (error) {
    if (method !== 'GET') throw error;
    await new Promise(resolve => setTimeout(resolve, 350));
    res = await doFetch(path, options, headers);
  }

  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text || null; }
  if (res.status === 401 && token) {
    expireSession();
    throw new ApiError(401, { error: 'Your session expired. Please sign in again.' });
  }
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, payload?: unknown) =>
    request<T>(path, { method: 'POST', body: payload !== undefined ? JSON.stringify(payload) : undefined })
};
