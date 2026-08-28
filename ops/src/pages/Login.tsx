import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

export function Login() {
  const { principal, login, loading, error } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const navigate = useNavigate();
  if (principal) return <Navigate to="/" replace />;
  async function handleSubmit(e: FormEvent) { e.preventDefault(); try { await login(email.trim(), password); navigate('/'); } catch { /* auth state */ } }
  return <div className="roviq-shell roviq-grid-glow flex min-h-screen items-center justify-center px-5 py-10"><form onSubmit={handleSubmit} className="roviq-panel w-full max-w-md p-7 sm:p-8"><div className="roviq-brand"><span className="roviq-mark"><span>R</span></span><span>ROVIQ</span></div><p className="roviq-kicker mt-8">Operations console</p><h1 className="mt-2 text-3xl font-bold tracking-tight">Staff sign in</h1><p className="roviq-muted mt-2 text-sm">Authorized ROVIQ operations accounts only.</p><div className="mt-7 space-y-5"><div><label className="mb-2 block text-sm font-medium" htmlFor="email">Email</label><input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="roviq-input" /></div><div><label className="mb-2 block text-sm font-medium" htmlFor="password">Password</label><div className="relative"><input id="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className="roviq-input pr-20" /><button type="button" onClick={() => setShowPassword((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-[var(--roviq-copper-soft)]">{showPassword ? 'Hide' : 'Show'}</button></div></div></div>{error && <p className="mt-4 text-sm text-red-300">{error}</p>}<button type="submit" disabled={loading} className="roviq-btn-primary mt-6 w-full">{loading ? 'Signing in…' : 'Enter operations'}</button></form></div>;
}
