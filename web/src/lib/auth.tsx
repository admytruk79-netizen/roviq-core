import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, getToken, SESSION_EXPIRED_EVENT, setToken } from './api';
import { authenticateCustomer } from './customer-auth';
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
    localStorage.removeItem(PRINCIPAL_KEY);
    setPrincipal(null);

    try {
      const session = await authenticateCustomer(email, password, {
        post: api.post,
        setToken
      });

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
