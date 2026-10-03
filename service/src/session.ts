// One sign-in for every ROVIQ workspace. The shell signs in once, obtains a token scoped to each
// role the account holds, and hands each tab its token under the storage keys that role's app
// already reads. Each tab's app then runs exactly as it does standalone, with one role's access.

export type Role = 'customer' | 'diagnostic' | 'tow' | 'partner' | 'parts' | 'fleet' | 'admin';
export type Workspace = { role: Role; label: string; path: string; tokenKey: string; principalKey: string };

export const WORKSPACES: readonly Workspace[] = [
  { role: 'customer', label: 'My service', path: 'customer/', tokenKey: 'roviq_access_token', principalKey: 'roviq_principal' },
  { role: 'diagnostic', label: 'Diagnostic', path: 'diagnostic/', tokenKey: 'roviq_diagnostic_token', principalKey: 'roviq_diagnostic_principal' },
  { role: 'tow', label: 'Tow', path: 'tow/', tokenKey: 'roviq_tow_token', principalKey: 'roviq_tow_principal' },
  { role: 'partner', label: 'Shop', path: 'partner/', tokenKey: 'roviq_partner_token', principalKey: 'roviq_partner_principal' },
  { role: 'parts', label: 'Parts', path: 'parts/', tokenKey: 'roviq_parts_token', principalKey: 'roviq_parts_principal' },
  { role: 'fleet', label: 'Mobility', path: 'fleet/', tokenKey: 'roviq_fleet_token', principalKey: 'roviq_fleet_principal' },
  { role: 'admin', label: 'Ops', path: 'ops/', tokenKey: 'roviq_ops_token', principalKey: 'roviq_ops_principal' }
];

const SESSION_KEY = 'roviq_service_session';
const LAST_TAB_KEY = 'roviq_service_last_tab';
const API = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

export type ServiceSession = { roles: Role[]; testMode: boolean; email: string };
type TokenResponse = { accessToken: string; principal: { role: string; actorId?: string | null } };
type LoginResponse = TokenResponse & { roles?: { role: string; actorId?: string | null }[] };

export class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

async function call<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  if (init.token) headers.set('authorization', `Bearer ${init.token}`);
  const res = await fetch(`${API}${path}`, { ...init, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, typeof body.error === 'string' ? body.error : `http_${res.status}`);
  return body as T;
}

function storeTab(workspace: Workspace, session: TokenResponse) {
  localStorage.setItem(workspace.tokenKey, session.accessToken);
  localStorage.setItem(workspace.principalKey, JSON.stringify({ role: session.principal.role, actorId: session.principal.actorId ?? null }));
}

function tokenUsable(token: string | null) {
  if (!token) return false;
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number };
    return typeof payload.exp !== 'number' || payload.exp * 1000 > Date.now();
  } catch { return false; }
}

export function workspaceFor(role: Role) {
  return WORKSPACES.find((w) => w.role === role)!;
}

/**
 * Sign in and prepare a token for every workspace the account can open. A customer or business account gets
 * the roles it has been granted; the ROVIQ admin uses Ops directly and clearly labelled
 * test accounts for customer and service workspaces, never real businesses' identities.
 */
export async function signIn(email: string, password: string): Promise<ServiceSession> {
  signOut();
  const login = await call<LoginResponse>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  const serviceRoles = new Set<string>(WORKSPACES.map((w) => w.role));
  const opened: Role[] = [];

  if (login.principal.role === 'admin') {
    storeTab(workspaceFor('admin'), login);
    opened.push('admin');
    for (const workspace of WORKSPACES.filter((w) => w.role !== 'admin')) {
      const test = await call<TokenResponse>(`/api/admin/testing/${workspace.role}-session`, { method: 'POST', body: '{}', token: login.accessToken });
      storeTab(workspace, test);
      opened.push(workspace.role);
    }
  } else {
    const held = (login.roles ?? [login.principal]).map((r) => r.role).filter((r): r is Role => serviceRoles.has(r));
    for (const role of held) {
      const workspace = workspaceFor(role);
      const scoped = role === login.principal.role
        ? login
        : await call<TokenResponse>('/api/auth/switch-role', { method: 'POST', body: JSON.stringify({ role }), token: login.accessToken });
      storeTab(workspace, scoped);
      opened.push(role);
    }
  }

  if (!opened.length) throw new ApiError(403, 'no_service_workspace');
  const session: ServiceSession = { roles: WORKSPACES.map((w) => w.role).filter((r) => opened.includes(r)), testMode: login.principal.role === 'admin', email };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

/** The current session, if every one of its tabs still holds an unexpired token. */
export function restoreSession(): ServiceSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as ServiceSession;
    if (!Array.isArray(session.roles) || !session.roles.length) return null;
    if (!session.roles.every((role) => tokenUsable(localStorage.getItem(workspaceFor(role).tokenKey)))) {
      signOut();
      return null;
    }
    return session;
  } catch {
    signOut();
    return null;
  }
}

export function signOut() {
  localStorage.removeItem(SESSION_KEY);
  for (const workspace of WORKSPACES) {
    localStorage.removeItem(workspace.tokenKey);
    localStorage.removeItem(workspace.principalKey);
  }
}

/** True when a storage change means one of this session's tabs lost its sign-in. */
export function isTabSignOut(event: StorageEvent, session: ServiceSession) {
  if (event.key === null) return true;
  if (event.newValue !== null) return false;
  return session.roles.some((role) => workspaceFor(role).tokenKey === event.key);
}

export function lastTab(session: ServiceSession): Role {
  const saved = (() => { try { return localStorage.getItem(LAST_TAB_KEY); } catch { return null; } })();
  return session.roles.includes(saved as Role) ? (saved as Role) : session.roles[0];
}

export function rememberTab(role: Role) {
  try { localStorage.setItem(LAST_TAB_KEY, role); } catch { /* per-device convenience only */ }
}

export function signInMessage(error: unknown) {
  if (error instanceof ApiError) {
    if (error.code === 'invalid_credentials') return 'Email or password is incorrect.';
    if (error.code === 'no_service_workspace') return 'This account has no active ROVIQ workspace.';
    if (error.status === 429) return 'Too many sign-in attempts. Wait a minute and try again.';
    return `Sign-in failed (${error.code}). Try again.`;
  }
  return 'Could not reach ROVIQ. Check your connection and try again.';
}
