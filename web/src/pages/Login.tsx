import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

export function Login() {
  const { principal, login, loading, error } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const navigate = useNavigate();

  if (principal) return <Navigate to="/" replace />;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    try {
      await login(email, password);
      navigate('/');
    } catch {
      // error is surfaced via auth state
    }
  }

  return (
    <div className="roviq-shell roviq-grid-glow grid min-h-screen lg:grid-cols-[1.08fr_.92fr]">
      <section className="hidden min-h-screen flex-col justify-between border-r border-white/10 p-12 lg:flex">
        <div className="roviq-brand">
          <span className="roviq-mark"><span>R</span></span>
          <span>ROVIQ</span>
        </div>
        <div className="max-w-xl pb-14">
          <p className="roviq-kicker mb-5">Vehicle service, coordinated</p>
          <h1 className="text-6xl font-black leading-[0.96] tracking-[-0.045em]">
            One case.<br />One clear plan.<br /><span className="roviq-green">Back on the road.</span>
          </h1>
          <p className="roviq-muted mt-7 max-w-lg text-lg leading-8">
            Report the problem, follow your Service Plan, approve work and see every handoff in one place.
          </p>
        </div>
        <p className="roviq-muted text-xs">ROVIQ Maintenance</p>
      </section>

      <section className="flex min-h-screen items-center justify-center px-5 py-10 sm:px-8">
        <form onSubmit={handleSubmit} className="roviq-panel w-full max-w-md p-6 sm:p-8">
          <div className="mb-8 lg:hidden">
            <div className="roviq-brand">
              <span className="roviq-mark"><span>R</span></span>
              <span>ROVIQ</span>
            </div>
          </div>
          <p className="roviq-kicker">Customer portal</p>
          <h2 className="mt-2 text-3xl font-bold tracking-tight">Welcome back</h2>
          <p className="roviq-muted mt-2 text-sm">Sign in to view and manage your active service cases.</p>

          <div className="mt-7 space-y-5">
            <div>
              <label className="mb-2 block text-sm font-medium" htmlFor="email">Email</label>
              <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="roviq-input" placeholder="you@example.com" />
            </div>
            <div>
              <label className="mb-2 block text-sm font-medium" htmlFor="password">Password</label>
              <input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className="roviq-input" placeholder="••••••••••••" />
            </div>
          </div>

          {error && <p className="mt-4 rounded-lg border border-red-400/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}
          <button type="submit" disabled={loading} className="roviq-btn-primary mt-6 w-full">
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
          <p className="roviq-muted mt-5 text-center text-xs">Secure access to your ROVIQ Service Plan and case timeline.</p>
        </form>
      </section>
    </div>
  );
}
