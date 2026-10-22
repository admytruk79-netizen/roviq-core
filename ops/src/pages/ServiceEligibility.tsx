import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '../lib/api';

type Registry = {
  organizations: { id: string; name: string; managed: boolean }[];
  authorizations: { organization_id: string; service: string; eligible: boolean; effective_state: string; expires_at: string | null; evidence_reference: string; review_reason: string }[];
  review: { organization_id: string; case_id: string | null; service: string; reference_type: string; reference_id: string; business_name: string }[];
};
const services = ['repair','diagnostic','tow','valet','parts','mobility'];
const field = 'mt-1 w-full rounded border border-slate-300 bg-white p-2 text-slate-900';
export function ServiceEligibility() {
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [organization, setOrganization] = useState('');
  const [service, setService] = useState('repair');
  const [state, setState] = useState('verified');
  const [validFrom, setValidFrom] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const refresh = async () => setRegistry(await api.get<Registry>('/api/admin/service-eligibility'));
  useEffect(() => {
    let active = true;
    const load = () => api.get<Registry>('/api/admin/service-eligibility').then(r => { if (active) setRegistry(r); })
      .catch(() => { if (active) setError('Could not load service eligibility. Use Refresh to retry.'); });
    load(); const timer = setInterval(load, 30_000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  const selected = registry?.organizations.find(o => o.id === organization);
  const records = registry?.authorizations.filter(c => c.organization_id === organization) ?? [];
  async function enroll() {
    setBusy(true); setError(''); setNotice('');
    try { await api.post(`/api/admin/service-eligibility/${organization}/enroll`, {}); await refresh(); setNotice('Credential checks enabled. New work requires a verified, current service authorization.'); }
    catch { setError('Could not enable checks. Retry with the same business.'); }
    finally { setBusy(false); }
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    if (!validFrom || (state === 'verified' && !expiresAt)) { setError('Enter validity dates. Verified services require an expiry.'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      await api.put(`/api/admin/service-eligibility/${organization}/${service}`, { state, validFrom: new Date(validFrom).toISOString(),
        ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}), evidenceReference: reference, reason });
      await refresh(); setNotice('Service authorization reviewed. Eligibility is checked again on assignment and acceptance.');
    } catch { setError('Could not save the review. Check the dates, evidence reference and reason, then retry.'); }
    finally { setBusy(false); }
  }
  return <div className="space-y-5">
    <h1 className="text-2xl font-semibold">Service eligibility</h1>
    <p className="text-sm text-slate-500">Business credentials control service eligibility, separately from staff logins. Expiry blocks new assignments and acceptance. Existing work remains visible for Ops review. Geography, capacity, tools and customer authorization still require their existing checks.</p>
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    {notice && <p role="status" className="text-sm text-emerald-600">{notice}</p>}
    <button type="button" className="min-h-11 underline" onClick={() => { setError(''); refresh().catch(() => setError('Could not refresh eligibility.')); }}>Refresh eligibility</button>
    <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-5 text-slate-900">
      <label className="block text-sm">Business<select aria-label="Business" className={field} value={organization} onChange={e => { setOrganization(e.target.value); setNotice(''); }}><option value="">Choose a business</option>{registry?.organizations.map(o => <option key={o.id} value={o.id}>{o.name} · {o.managed ? 'Checks enabled' : 'Legacy: enrollment required'}</option>)}</select></label>
      {selected && !selected.managed && <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm"><p>This business is outside the new credential checks. Enabling them immediately requires valid authorizations for new service assignments. Existing jobs will be flagged for review if their authorization is missing or expired.</p><button disabled={busy} type="button" className="mt-2 min-h-11 underline" onClick={enroll}>Enable credential checks for this business</button></div>}
      {selected?.managed && <>
        <p className="font-medium">{records.filter(c => c.eligible).length} currently authorized services</p>
        <ul className="space-y-2 text-sm">{records.map(c => <li key={c.service} className="rounded border border-slate-200 p-3"><strong>{c.service}: {c.effective_state.replaceAll('_',' ')}</strong><p>{c.expires_at ? `Expires ${new Date(c.expires_at).toLocaleString()}` : 'No expiry recorded'}</p><p>Evidence: {c.evidence_reference}</p><p>Review: {c.review_reason}</p></li>)}</ul>
        <form onSubmit={save}><fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-2 font-semibold">Verify, renew or suspend a service</legend>
          <p className="text-sm text-slate-600 sm:col-span-2">Review the required credentials outside this form. Record an evidence reference and the earliest expiry across all required credentials. Saving here records your decision; it does not independently verify a license with its issuer. Dates use your local time.</p>
          <label className="text-sm">Service<select aria-label="Service" className={field} value={service} onChange={e => setService(e.target.value)}>{services.map(s => <option key={s}>{s}</option>)}</select></label>
          <label className="text-sm">Decision<select aria-label="Decision" className={field} value={state} onChange={e => setState(e.target.value)}>{['verified','pending','suspended','revoked'].map(s => <option key={s}>{s}</option>)}</select></label>
          <label className="text-sm">Valid from<input type="datetime-local" required className={field} value={validFrom} onChange={e => setValidFrom(e.target.value)} /></label>
          <label className="text-sm">Expiry<input type="datetime-local" required={state === 'verified'} className={field} value={expiresAt} onChange={e => setExpiresAt(e.target.value)} /></label>
          <label className="text-sm">Evidence reference<input required minLength={3} maxLength={300} className={field} value={reference} onChange={e => setReference(e.target.value)} /></label>
          <label className="text-sm">Review reason<input required minLength={5} maxLength={500} className={field} value={reason} onChange={e => setReason(e.target.value)} /></label>
          <button type="submit" className="min-h-11 rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50">{busy ? 'Saving…' : 'Record service review'}</button>
        </fieldset></form>
      </>}
    </section>
    <section className="rounded-xl border border-slate-200 bg-white p-5 text-slate-900"><h2 className="font-semibold">Existing work requiring credential review ({registry?.review.length ?? 0})</h2>
      <p className="mt-2 text-sm text-slate-600">Review safety and arrange reassignment when needed. Jobs are not automatically cancelled. This list refreshes every 30 seconds.</p>
      <ul className="mt-3 space-y-2 text-sm">{registry?.review.map(r => <li key={`${r.reference_type}-${r.reference_id}`} className="rounded border border-amber-300 p-3">{r.business_name} · {r.service} · {r.reference_type}<br />{r.case_id ? <a className="underline" href={`#/cases/${r.case_id}`}>Review case {r.case_id}</a> : <span>Standalone repair order {r.reference_id}</span>}</li>)}</ul>
    </section>
  </div>;
}
