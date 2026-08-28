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
      const res = await api.post<{ accessToken: string; principal: Principal }>('/api/auth/login', { email, password });

      if (res.principal.role === 'admin') {
        setToken(res.accessToken);
        const testSession = await api.post<{ accessToken: string; principal: Principal; recoveredCaseCount?: number }>(
          '/api/admin/testing/customer-session',
          {}
        );
        setToken(testSession.accessToken);
        localStorage.setItem(PRINCIPAL_KEY, JSON.stringify(testSession.principal));
        setPrincipal(testSession.principal);
        return;
      }

      if (res.principal.role !== 'customer' || !res.principal.actorId) {
        setToken(null);
        localStorage.removeItem(PRINCIPAL_KEY);
        setError('This portal requires a customer account.');
        throw new Error('wrong_role');
      }

      setToken(res.accessToken);
      localStorage.setItem(PRINCIPAL_KEY, JSON.stringify(res.principal));
      setPrincipal(res.principal);
    } catch (err) {
      if (err instanceof Error && err.message === 'wrong_role') throw err;
      setToken(null);
      localStorage.removeItem(PRINCIPAL_KEY);
      setError('Invalid email or password.');
      throw new Error('login_failed');
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
