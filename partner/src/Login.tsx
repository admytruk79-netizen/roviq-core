import { useState, type FormEvent } from 'react';
import { useAuth } from './auth';
import roviqLogo from './brand/roviq-lockup-dark.svg';
import { RegisterShop } from './RegisterShop';

// Built as the standalone ROVIQ Shop OS app (VITE_PRODUCT=shop) the sign-in speaks to a shop
// running its own business, and a new shop can register here. Embedded in Actor it stays the
// network partner sign-in.
const SHOP_APP = import.meta.env.VITE_PRODUCT === 'shop';

export function Login() {
  const { login, loading, error } = useAuth();
  const standalone = typeof window !== 'undefined' && window.self === window.top;
  const [view, setView] = useState<'sign-in' | 'register'>(() => (SHOP_APP && new URLSearchParams(window.location.search).get('setup') === 'shop' ? 'register' : 'sign-in'));
  const [notice, setNotice] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  async function submit(event: FormEvent) { event.preventDefault(); try { await login(email.trim(), password); } catch { /* surfaced by auth state */ } }

  return (
    <div className="shell grid-glow grid min-h-screen lg:grid-cols-[1.05fr_.95fr]">
      <section className="hidden min-h-screen flex-col justify-between border-r border-white/10 p-12 lg:flex">
        <div className="brand"><img className="roviq-logo" src={roviqLogo} alt="ROVIQ" /></div>
        {SHOP_APP
          ? <div className="max-w-2xl pb-14"><p className="kicker mb-5">ROVIQ Shop OS</p><h1 className="text-6xl font-black leading-[.96] tracking-[-.045em]">Run your shop.<br />Keep customers<br /><span className="text-[var(--green)]">in the loop.</span></h1><p className="muted mt-7 max-w-xl text-lg leading-8">Repair orders, digital inspections with photos, customer approvals by link, payments and end-of-day books in one place. Join the ROVIQ network only when you choose.</p></div>
          : <div className="max-w-2xl pb-14"><p className="kicker mb-5">Partner operations</p><h1 className="text-6xl font-black leading-[.96] tracking-[-.045em]">Work arrives<br />with context.<br /><span className="text-[var(--green)]">You stay in control.</span></h1><p className="muted mt-7 max-w-xl text-lg leading-8">Review coordinated service requests, declare capacity and control when ROVIQ can route work to your operation.</p></div>}
        <p className="muted text-xs">{SHOP_APP ? 'ROVIQ Shop OS' : 'ROVIQ Shop & Dealership Network'}</p>
      </section>
      <section className="flex min-h-screen items-center justify-center px-5 py-10 sm:px-8">{view === 'register' ? (
        <RegisterShop onBack={() => setView('sign-in')} onCreated={(created) => { setEmail(created); setPassword(''); setNotice('Your shop workspace is ready. Sign in to begin setup.'); setView('sign-in'); }} />
      ) : <form onSubmit={submit} className="panel w-full max-w-md p-6 sm:p-8">
        <div className="mb-8 lg:hidden"><div className="brand"><img className="roviq-logo" src={roviqLogo} alt="ROVIQ" /></div></div>
        <p className="kicker">{SHOP_APP ? 'ROVIQ Shop OS' : 'Shop / Dealership portal'}</p><h2 className="mt-2 text-3xl font-bold tracking-tight">{SHOP_APP ? 'Sign in to your shop' : 'Partner sign in'}</h2><p className="muted mt-2 text-sm">Sign in to your shop workspace.</p>
        {notice && <p role="status" className="mt-4 rounded-lg border border-emerald-400/20 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">{notice}</p>}
        <div className="mt-7 space-y-5"><div><label htmlFor="email" className="mb-2 block text-sm font-medium">Email</label><input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="input" placeholder="operations@shop.com" /></div><div><label htmlFor="password" className="mb-2 block text-sm font-medium">Password</label><div className="password-wrap"><input id="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className="input" placeholder="••••••••••••" /><button type="button" className="password-toggle" onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? 'Hide' : 'Show'}</button></div></div></div>
        {error && <p role="alert" aria-live="assertive" className="mt-4 rounded-lg border border-red-400/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}<button className="primary mt-6 w-full" type="submit" disabled={loading} aria-busy={loading}>{loading ? 'Signing in…' : SHOP_APP ? 'Open Shop OS' : 'Enter partner portal'}</button>
        <p className="muted mt-4 text-sm">Starting a shop? {SHOP_APP && standalone
          ? <button type="button" className="underline" onClick={() => setView('register')}>Create your shop workspace</button>
          : <a href="/?setup=shop">Create your shop workspace</a>}.</p>
      </form>}</section>
    </div>
  );
}
