import { createContext, useContext, useState, type ReactNode } from 'react';
import { api, setToken } from './api';

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
  const raw = localStorage.getItem(PRINCIPAL_KEY);
  if (!raw) return null;
  try {
    const principal = JSON.parse(raw) as Principal;
    return principal.role === 'partner' && principal.actorId ? principal : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [principal, setPrincipal] = useState<Principal | null>(readPrincipal);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function login(email: string, password: string) {
    setLoading(true);
    setError(null);
    try {
      const result = await api.post<{ accessToken: string; principal: Principal }>('/api/auth/login', { email: email.trim(), password });
      if (result.principal.role !== 'partner' || !result.principal.actorId) {
        setToken(null);
        localStorage.removeItem(PRINCIPAL_KEY);
        setError('This portal requires a shop or dealership partner account.');
        throw new Error('wrong_role');
      }
      setToken(result.accessToken);
      localStorage.setItem(PRINCIPAL_KEY, JSON.stringify(result.principal));
      setPrincipal(result.principal);
    } catch (err) {
      if ((err as Error).message !== 'wrong_role') setError('Invalid email or password.');
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
  const value = useContext(AuthContext);
  if (!value) throw new Error('AuthProvider missing');
  return value;
}
