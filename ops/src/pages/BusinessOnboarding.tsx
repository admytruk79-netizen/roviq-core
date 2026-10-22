import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from '../lib/api';

type Business = { actorId: string; businessName: string; operatorName: string; role: string; email: string; locationName: string };
const roles = [{ value: 'partner', label: 'Shop / dealership' }, { value: 'diagnostic', label: 'Diagnostics' },
  { value: 'tow', label: 'Tow / recovery' }, { value: 'parts', label: 'Parts supplier' }, { value: 'fleet', label: 'Fleet / mobility' }];
const initial = { businessName: '', operatorName: '', role: 'partner', email: '', password: '', locationName: '', address: '', city: '', region: '', countryCode: 'US' };
const inputClass = 'mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-slate-900';

export function BusinessOnboarding() {
  const [form, setForm] = useState(initial);
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const request = useRef<string | null>(null);
  const lastDetails = useRef('');
  const refresh = async () => setBusinesses((await api.get<{ businesses: Business[] }>('/api/admin/business-onboarding')).businesses);
  useEffect(() => { refresh().catch(() => setError('Could not load onboarded businesses. Use Refresh to retry.')); }, []);
  function change(key: keyof typeof initial, value: string) {
    setForm(current => ({ ...current, [key]: value })); setSuccess('');
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    const { locationName, address, city, region, countryCode, ...operator } = form;
    const details = { ...operator, location: { name: locationName, address, city, region, countryCode } };
    // Keep the same retry key until a successful response. Never persist credentials in storage.
    const comparison = JSON.stringify({ ...details, password: undefined });
    if (!request.current || comparison !== lastDetails.current) { request.current = crypto.randomUUID(); lastDetails.current = comparison; }
    setBusy(true); setError(''); setSuccess('');
    try {
      const result = await api.post<{ business: { actorId: string } }>('/api/admin/business-onboarding', { requestId: request.current, ...details });
      request.current = null; setForm(initial);
      setSuccess(`Business account created (${result.business.actorId}). The operator can sign in to the Actor app. Configure and verify service readiness before assigning work.`);
      await refresh().catch(() => setError('Account created, but the list could not refresh. Use Refresh.'));
    } catch (err) {
      const code = err instanceof ApiError ? err.message : '';
      setError(code === 'onboarding_identity_or_request_exists' ? 'That email or request already exists. No partial business was created. Check the list before retrying.' :
        code === 'onboarding_retry_conflict' ? 'This retry has different details or credentials. Restore the original details, or reload and check the business list before starting again.' :
        'Could not create the account. Check the fields and retry with the same details.');
    } finally { setBusy(false); }
  }
  return <div className="space-y-5">
    <div><h1 className="text-2xl font-semibold">Business onboarding</h1>
      <p className="mt-2 text-sm text-slate-500">Create one business location and its first operator login. For a business already on the platform, manage its existing actors and role grants instead of creating a duplicate.</p></div>
    <section className="rounded-xl border border-slate-200 bg-white p-5 text-slate-900">
      <h2 className="font-semibold">New business and operator</h2>
      <p className="mt-2 text-sm text-slate-600">Confirm the operator’s identity and email outside the app. Arrange credentials directly with them through an agreed secure channel. This form does not email credentials. Login access does not verify certifications, capacity, integrations, or payment readiness.</p>
      {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
      {success && <p role="status" className="mt-3 text-sm text-emerald-800">{success}</p>}
      <form onSubmit={submit} className="mt-4"><fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">Business name<input required maxLength={120} minLength={2} className={inputClass} value={form.businessName} onChange={e => change('businessName', e.target.value)} /></label>
        <label className="text-sm">Workspace<select aria-label="Workspace" className={inputClass} value={form.role} onChange={e => change('role', e.target.value)}>{roles.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}</select></label>
        <label className="text-sm">Operator name<input required maxLength={100} minLength={2} className={inputClass} autoComplete="name" value={form.operatorName} onChange={e => change('operatorName', e.target.value)} /></label>
        <label className="text-sm">Operator email<input required type="email" maxLength={254} autoComplete="off" className={inputClass} value={form.email} onChange={e => change('email', e.target.value)} /></label>
        <label className="text-sm">Initial password<input required type="password" minLength={12} maxLength={128} autoComplete="new-password" className={inputClass} value={form.password} onChange={e => change('password', e.target.value)} /></label>
        <label className="text-sm">Location name<input required minLength={2} maxLength={120} className={inputClass} value={form.locationName} onChange={e => change('locationName', e.target.value)} /></label>
        <label className="text-sm sm:col-span-2">Street address<input required minLength={3} maxLength={300} className={inputClass} value={form.address} onChange={e => change('address', e.target.value)} /></label>
        <label className="text-sm">City<input required minLength={2} maxLength={100} className={inputClass} value={form.city} onChange={e => change('city', e.target.value)} /></label>
        <label className="text-sm">State / region<input required minLength={2} maxLength={100} className={inputClass} value={form.region} onChange={e => change('region', e.target.value)} /></label>
        <label className="text-sm">Country code<input required minLength={2} maxLength={2} pattern="[A-Za-z]{2}" className={inputClass} value={form.countryCode} onChange={e => change('countryCode', e.target.value.toUpperCase())} /></label>
        <div className="flex items-end"><button className="min-h-11 rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50" type="submit">{busy ? 'Creating account…' : 'Create business account'}</button></div>
      </fieldset></form>
      <a className="mt-4 inline-block min-h-11 py-2 text-sm underline" href="https://roviq-service.pages.dev" target="_blank" rel="noopener noreferrer">Open Actor app</a>
    </section>
    <section className="rounded-xl border border-slate-200 bg-white p-5 text-slate-900">
      <div className="flex items-center justify-between gap-2"><h2 className="font-semibold">Recently onboarded businesses</h2><button type="button" className="min-h-11 text-sm underline" onClick={() => { setError(''); refresh().catch(() => setError('Could not refresh businesses.')); }}>Refresh</button></div>
      {!businesses.length && <p className="text-sm text-slate-500">No businesses created through this flow yet.</p>}
      <ul className="divide-y divide-slate-200">{businesses.map(b => <li key={b.actorId} className="py-3 text-sm"><p className="font-medium">{b.businessName} · {roles.find(r => r.value === b.role)?.label ?? b.role}</p><p>{b.operatorName} · {b.email} · {b.locationName}</p><p className="text-xs text-slate-500">Actor {b.actorId}</p></li>)}</ul>
    </section>
  </div>;
}
