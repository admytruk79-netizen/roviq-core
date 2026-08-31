import { createContext, useContext, useState, type ReactNode } from 'react';
import { api, setToken } from './api';
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
  const raw = localStorage.getItem(PRINCIPAL_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Principal;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [principal, setPrincipal] = useState<Principal | null>(loadStoredPrincipal);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        session = await api.post<{ accessToken: string; principal: Principal; recoveredCaseCount?: number }>(
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
