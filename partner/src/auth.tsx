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
      const result = await api.post<{ accessToken: string; principal: Principal }>('/api/auth/login', { email: email.trim(), password });

      if (result.principal.role === 'admin') {
        setToken(result.accessToken);
        const testSession = await api.post<{ accessToken: string; principal: Principal }>('/api/admin/testing/partner-session', {});
        setToken(testSession.accessToken);
        localStorage.setItem(PRINCIPAL_KEY, JSON.stringify(testSession.principal));
        setPrincipal(testSession.principal);
        return;
      }

      if (result.principal.role !== 'partner' || !result.principal.actorId) {
        clearSession();
        setError('This portal requires a shop or dealership partner account.');
        throw new Error('wrong_role');
      }

      setToken(result.accessToken);
      localStorage.setItem(PRINCIPAL_KEY, JSON.stringify(result.principal));
      setPrincipal(result.principal);
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      if (message !== 'wrong_role' && !message.includes('session expired')) {
        clearSession();
        setError('Invalid email or password.');
      }
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
