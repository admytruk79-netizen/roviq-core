import { useState, type FormEvent } from 'react';
import { useAuth } from './auth';

export function Login() {
  const { login, loading, error } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  async function submit(event: FormEvent) { event.preventDefault(); try { await login(email.trim(), password); } catch { /* surfaced by auth state */ } }

  return (
    <div className="shell grid-glow grid min-h-screen lg:grid-cols-[1.05fr_.95fr]">
      <section className="hidden min-h-screen flex-col justify-between border-r border-white/10 p-12 lg:flex">
        <div className="brand"><span className="mark"><span>R</span></span><span>ROVIQ</span></div>
        <div className="max-w-2xl pb-14"><p className="kicker mb-5">Partner operations</p><h1 className="text-6xl font-black leading-[.96] tracking-[-.045em]">Work arrives<br />with context.<br /><span className="text-[var(--green)]">You stay in control.</span></h1><p className="muted mt-7 max-w-xl text-lg leading-8">Review coordinated service requests, declare capacity and control when ROVIQ can route work to your operation.</p></div>
        <p className="muted text-xs">ROVIQ Shop & Dealership Network</p>
      </section>
      <section className="flex min-h-screen items-center justify-center px-5 py-10 sm:px-8"><form onSubmit={submit} className="panel w-full max-w-md p-6 sm:p-8">
        <div className="mb-8 lg:hidden"><div className="brand"><span className="mark"><span>R</span></span><span>ROVIQ</span></div></div>
        <p className="kicker">Shop / Dealership portal</p><h2 className="mt-2 text-3xl font-bold tracking-tight">Partner sign in</h2><p className="muted mt-2 text-sm">Use the partner account provisioned for your operation.</p>
        <div className="mt-7 space-y-5"><div><label htmlFor="email" className="mb-2 block text-sm font-medium">Email</label><input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="input" placeholder="operations@shop.com" /></div><div><label htmlFor="password" className="mb-2 block text-sm font-medium">Password</label><div className="password-wrap"><input id="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className="input" placeholder="••••••••••••" /><button type="button" className="password-toggle" onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? 'Hide' : 'Show'}</button></div></div></div>
        {error && <p className="mt-4 rounded-lg border border-red-400/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}<button className="primary mt-6 w-full" type="submit" disabled={loading}>{loading ? 'Signing in…' : 'Enter partner portal'}</button>
      </form></section>
    </div>
  );
}
