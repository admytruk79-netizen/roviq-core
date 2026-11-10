import { useState, type FormEvent } from 'react';

// Shop self-registration inside the standalone Shop OS app (same public endpoint the Actor
// shell uses). A shop with no other software signs up here and lands on the sign-in form.
const API = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';

type Draft = { businessName: string; operatorName: string; email: string; password: string; name: string; address: string; city: string; region: string; countryCode: string };

export function RegisterShop({ onBack, onCreated }: { onBack: () => void; onCreated: (email: string) => void }) {
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [draft, setDraft] = useState<Draft>({ businessName: '', operatorName: '', email: '', password: '', name: '', address: '', city: '', region: '', countryCode: '' });
  function change(key: keyof Draft, value: string) {
    setDraft((previous) => ({ ...previous, [key]: value }));
    // Edits are a new request; an unchanged retry keeps the key after a lost response.
    setRequestId(crypto.randomUUID());
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError('');
    const { name, address, city, region, countryCode, ...account } = draft;
    try {
      const response = await fetch(`${API}/api/shops/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId, ...account, location: { name, address, city, region, countryCode: countryCode.toUpperCase() } }) });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        if (response.status === 429) throw new Error('Too many setup attempts. Please try again later.');
        if (result.error === 'onboarding_identity_or_request_exists') throw new Error('This email is already registered. Sign in with your existing account.');
        if (result.error === 'onboarding_retry_conflict') throw new Error('These setup details have changed. Check them and try again.');
        throw new Error('Shop setup could not be completed. Check your details and try again.');
      }
      onCreated(draft.email.trim());
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to connect. Retry with the same details.'); }
    finally { setBusy(false); }
  }
  const fields: { key: keyof Draft; label: string; max: number; min?: number; type?: string; complete?: string; half?: boolean }[] = [
    { key: 'businessName', label: 'Shop name', max: 120, min: 2, complete: 'organization' },
    { key: 'operatorName', label: 'Your name', max: 100, min: 2, complete: 'name' },
    { key: 'email', label: 'Sign-in email', max: 254, type: 'email', complete: 'email' },
    { key: 'password', label: 'Password (12–128 characters)', min: 12, max: 128, type: showPassword ? 'text' : 'password', complete: 'new-password' },
    { key: 'name', label: 'Location name', max: 120, min: 2 },
    { key: 'address', label: 'Street address', max: 300, min: 3, complete: 'street-address' },
    { key: 'city', label: 'City', max: 100, min: 2, complete: 'address-level2', half: true },
    { key: 'region', label: 'Province / state', max: 100, min: 2, complete: 'address-level1', half: true },
    { key: 'countryCode', label: 'Country code (CA, US)', min: 2, max: 2, complete: 'country', half: true }
  ];
  return (
    <form onSubmit={submit} aria-busy={busy} className="panel w-full max-w-md p-6 sm:p-8">
      <p className="kicker">ROVIQ Shop OS</p>
      <h2 className="mt-2 text-3xl font-bold tracking-tight">Create your shop</h2>
      <p className="muted mt-2 text-sm">Your own shop system: repair orders, inspections, customer approvals, payments and your books. No other shop software needed.</p>
      <fieldset disabled={busy} className="mt-6 grid grid-cols-2 gap-4">
        <legend className="sr-only">Shop and owner details</legend>
        {fields.map((f) => (
          <div key={f.key} className={f.half ? 'col-span-1' : 'col-span-2'}>
            <label htmlFor={`reg-${f.key}`} className="mb-2 block text-sm font-medium">{f.label}</label>
            <input id={`reg-${f.key}`} name={f.key} type={f.type ?? 'text'} required minLength={f.min} maxLength={f.max} autoComplete={f.complete}
              value={draft[f.key]} onChange={(e) => change(f.key, e.target.value)} pattern={f.key === 'countryCode' ? '[A-Za-z]{2}' : undefined} className="input" />
          </div>
        ))}
        <button type="button" className="col-span-2 text-left text-sm underline" onClick={() => setShowPassword((v) => !v)} aria-pressed={showPassword}>{showPassword ? 'Hide password' : 'Show password'}</button>
        {error && <p role="alert" className="col-span-2 rounded-lg border border-red-400/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}
        <button className="primary col-span-2" type="submit">{busy ? 'Creating shop…' : 'Create shop workspace'}</button>
        <button type="button" className="col-span-2 text-sm underline" onClick={onBack}>Already have an account? Sign in</button>
      </fieldset>
    </form>
  );
}
