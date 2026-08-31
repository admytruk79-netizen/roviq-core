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
  // A remembered principal without a live bearer token is not an authenticated
  // session. Customer used to restore the principal independently, which could
  // bounce users away from /login while the token was already missing/expired.
  if (!getToken()) {
    localStorage.removeItem(PRINCIPAL_KEY);
    return null;
  }

  const raw = localStorage.getItem(PRINCIPAL_KEY);
  if (!raw) return null;
  try {
    const principal = JSON.parse(raw) as Principal;
    if (principal.role !== 'customer' || !principal.actorId) {
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

  useEffect(() => {
    const handleExpiredSession = () => {
      localStorage.removeItem(PRINCIPAL_KEY);
      setPrincipal(null);
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, handleExpiredSession);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handleExpiredSession);
  }, []);

  async function login(email: string, password: string) {
    setLoading(true);
    setError(null);

    // Start every login from a clean Customer session. In particular, do not
    // send an expired Customer bearer token along with the public login call.
    setToken(null);
    localStorage.removeItem(PRINCIPAL_KEY);
    setPrincipal(null);

    try {
      const result = await api.post<{ accessToken: string; principal: Principal }>(
        '/api/auth/login',
        { email: email.trim(), password }
      );

      let session = result;
      if (result.principal.role === 'admin') {
        // Mirror the working Tow / Valet handoff: authenticate as admin first,
        // then exchange that bearer token for a Customer-scoped session.
        setToken(result.accessToken);
        session = await api.post<{ accessToken: string; principal: Principal }>(
          '/api/admin/testing/customer-session',
          {}
        );
      }

      if (session.principal.role !== 'customer' || !session.principal.actorId) {
        throw new Error('This portal requires a customer account.');
      }

      setToken(session.accessToken);
      localStorage.setItem(PRINCIPAL_KEY, JSON.stringify(session.principal));
      setPrincipal(session.principal);
    } catch (err) {
      setToken(null);
      localStorage.removeItem(PRINCIPAL_KEY);
      setPrincipal(null);
      const message = err instanceof Error ? err.message : 'Unable to sign in';
      setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    setToken(null);
    localStorage.removeItem(PRINCIPAL_KEY);
    setPrincipal(null);
  }

  return <AuthContext.Provider value={{ principal, loading, error, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
