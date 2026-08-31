import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, getToken, SESSION_EXPIRED_EVENT, setToken } from './api';
import type { Principal } from './types';

const PRINCIPAL_KEY = 'roviq_principal';

type AuthState = {
  principal: Principal | null;
  loading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
};

const AuthContext = createContext<AuthState | null>(null);

function loadStoredPrincipal(): Principal | null {
  if (!getToken()) {
    localStorage.removeItem(PRINCIPAL_KEY);
    return null;
  }
  const raw = localStorage.getItem(PRINCIPAL_KEY);
  if (!raw) return null;
  try {
    const principal = JSON.parse(raw) as Principal;
    if (principal.role !== 'admin') {
      localStorage.removeItem(PRINCIPAL_KEY);
      setToken(null);
      return null;
    }
    return principal;
  } catch {
    localStorage.removeItem(PRINCIPAL_KEY);
    setToken(null);
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [principal, setPrincipal] = useState<Principal | null>(loadStoredPrincipal);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function clearSession(message?: string) {
    setToken(null);
    localStorage.removeItem(PRINCIPAL_KEY);
    setPrincipal(null);
    if (message) setError(message);
  }

  useEffect(() => {
    const onExpired = () => clearSession('Your session expired. Please sign in again.');
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  async function login(email: string, password: string) {
    setLoading(true);
    setError(null);

    // Ops stays direct-admin only. Start clean so an old bearer/principal pair
    // cannot influence a new administrator login attempt.
    clearSession();

    try {
      const res = await api.post<{ accessToken: string; principal: Principal }>(
        '/api/auth/login',
        { email: email.trim(), password }
      );
      if (res.principal.role !== 'admin') {
        throw new Error('not_admin');
      }
      setToken(res.accessToken);
      localStorage.setItem(PRINCIPAL_KEY, JSON.stringify(res.principal));
      setPrincipal(res.principal);
    } catch (e) {
      const message = e instanceof Error && e.message === 'not_admin'
        ? 'This account is not an ops staff account.'
        : e instanceof Error && e.message.includes('session expired')
          ? 'Your session expired. Please sign in again.'
          : 'Invalid email or password.';
      clearSession(message);
      throw new Error('login_failed');
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    clearSession();
  }

  return <AuthContext.Provider value={{ principal, loading, error, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
