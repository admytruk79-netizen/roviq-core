import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, getToken, SESSION_EXPIRED_EVENT, setToken } from './api';

export type Principal = {
  role: 'partner' | 'diagnostic' | 'tow' | 'parts' | 'fleet' | 'admin' | 'customer';
  actorId?: string | null;
  email?: string | null;
};

type AuthContextValue = {
  principal: Principal | null;
  loading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
};

const PRINCIPAL_KEY = 'roviq_partner_principal';
const AuthContext = createContext<AuthContextValue | null>(null);

function readPrincipal(): Principal | null {
  if (!getToken()) {
    localStorage.removeItem(PRINCIPAL_KEY);
    return null;
  }
  const raw = localStorage.getItem(PRINCIPAL_KEY);
  if (!raw) return null;
  try {
    const principal = JSON.parse(raw) as Principal;
    return principal.role === 'partner' && principal.actorId ? principal : null;
  } catch {
    localStorage.removeItem(PRINCIPAL_KEY);
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [principal, setPrincipal] = useState<Principal | null>(readPrincipal);
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
    try {
      const result = await api.post<{ accessToken: string; principal: Principal }>(
        '/api/auth/login',
        { email: email.trim(), password }
      );

      let session = result;
      if (result.principal.role === 'admin') {
        setToken(result.accessToken);
        session = await api.post<{ accessToken: string; principal: Principal }>(
          '/api/admin/testing/partner-session',
          {}
        );
      }

      if (session.principal.role !== 'partner' || !session.principal.actorId) {
        throw new Error('This portal requires a shop or dealership partner account.');
      }

      setToken(session.accessToken);
      localStorage.setItem(PRINCIPAL_KEY, JSON.stringify(session.principal));
      setPrincipal(session.principal);
    } catch (err) {
      clearSession();
      const message = err instanceof Error ? err.message : 'Unable to sign in';
      setError(message);
      throw err;
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
  const value = useContext(AuthContext);
  if (!value) throw new Error('AuthProvider missing');
  return value;
}
