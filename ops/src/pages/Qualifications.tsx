import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from '../lib/api';

type Actor = { id: string; actor_type: string; status: string; business_name: string | null; display_name: string | null };
type Evidence = { id: string; requirement_key: string; kind: string; scope: string | null; evidence_status: string;
  effective_status: string; verified_source: string; valid_until: string | null; review_version: number };
type History = { id: string; occurred_at: string; principal_identity_id: string;
  metadata: { after: { requirement_key: string; evidence_status: string; review_reason: string } } };
type Registry = { evidence: Evidence[]; history: History[] };
type Evaluation = { evaluation: { decision: string; results: { requirementId: string; satisfied: boolean; reason: string }[] } };
const kinds = ['legal_license','oem_certification','manufacturer_access','training','equipment','facility','parts','capacity','authorization'];
const field = 'mt-1 w-full rounded border border-slate-300 bg-white p-2 text-slate-900';
const localDate = (iso: string) => { const d = new Date(iso); return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16); };

export function Qualifications() {
  const [search,setSearch] = useState(''); const [query,setQuery] = useState('');
  const [actors,setActors] = useState<Actor[]>([]); const [truncated,setTruncated] = useState(false);
  const [actor,setActor] = useState(''); const [registry,setRegistry] = useState<Registry | null>(null);
  const [id,setId] = useState(''); const [version,setVersion] = useState(0);
  const [key,setKey] = useState(''); const [kind,setKind] = useState('training'); const [scope,setScope] = useState('');
  const [status,setStatus] = useState('unverified'); const [source,setSource] = useState('');
  const [expiry,setExpiry] = useState(''); const [noExpiry,setNoExpiry] = useState(false); const [reason,setReason] = useState('');
  const [busy,setBusy] = useState(false); const [error,setError] = useState(''); const [notice,setNotice] = useState('');
  const [caseId,setCaseId] = useState(''); const [evaluation,setEvaluation] = useState<Evaluation | null>(null);
  function reset() {
    setId(''); setVersion(0); setKey(''); setKind('training'); setScope(''); setStatus('unverified');
    setSource(''); setExpiry(''); setNoExpiry(false); setReason('');
  }
  useEffect(() => {
    let active = true;
    api.get<{actors:Actor[];truncated:boolean}>(`/api/admin/qualifications/actors?search=${encodeURIComponent(query)}`)
      .then(r => { if(active) { setActors(r.actors); setTruncated(r.truncated); } })
      .catch(() => { if(active) setError('Could not load operators. Search again to retry.'); });
    return () => { active=false; };
  },[query]);
  useEffect(() => {
    let active = true; setRegistry(null); setEvaluation(null); setError(''); setNotice(''); reset();
    if(actor) api.get<Registry>(`/api/admin/qualifications/${actor}`).then(r => { if(active) setRegistry(r); })
      .catch(() => { if(active) setError('Could not load evidence. Select the operator again to retry.'); });
    return () => { active=false; };
  },[actor]);
  function edit(e: Evidence) {
    setId(e.id); setVersion(e.review_version); setKey(e.requirement_key); setKind(e.kind); setScope(e.scope ?? '');
    setStatus(e.evidence_status); setSource(e.verified_source ?? ''); setExpiry(e.valid_until ? localDate(e.valid_until) : '');
    setNoExpiry(!e.valid_until); setReason(''); setNotice(''); setError('');
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if(busy) return;
    const evidenceId = id || crypto.randomUUID(); setId(evidenceId);
    setBusy(true); setError(''); setNotice('');
    try {
      await api.put(`/api/admin/qualifications/${actor}/${evidenceId}`, { expectedVersion:version,
        requirementKey:key,kind,scope:scope.trim() || null,status,source,
        validUntil:noExpiry ? null : new Date(expiry).toISOString(),reason });
      reset(); setEvaluation(null);
      setRegistry(await api.get<Registry>(`/api/admin/qualifications/${actor}`));
      setNotice('Review recorded. Select a case to check its qualification requirements again.');
    } catch(e) {
      if(e instanceof ApiError && e.status === 409) {
        setError('The record changed or the operator cannot be verified. Reload evidence and review the current record before saving.');
      } else setError('Could not confirm the review. Reload evidence before retrying; your request may have reached the server.');
    } finally { setBusy(false); }
  }
  async function reload() {
    setBusy(true); setError('');
    try { setRegistry(await api.get<Registry>(`/api/admin/qualifications/${actor}`)); reset(); setEvaluation(null); }
    catch { setError('Could not reload evidence. Try again.'); } finally { setBusy(false); }
  }
  async function check(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setEvaluation(null);
    try { setEvaluation(await api.get<Evaluation>(`/api/admin/qualifications/${actor}/cases/${caseId.trim()}`)); }
    catch { setError('Could not evaluate qualifications. Check the case ID and try again.'); } finally { setBusy(false); }
  }
  return <div className="space-y-5">
    <h1 className="text-2xl font-semibold">Operator qualifications</h1>
    <p className="text-sm text-slate-500">Review technician and operator evidence against case-specific requirements. Business service authorizations are managed separately in Eligibility. Only identified administrators can record reviews.</p>
    {error && <p role="alert" className="text-red-600">{error}</p>}{notice && <p role="status" className="text-emerald-600">{notice}</p>}
    <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-5 text-slate-900">
      <form onSubmit={e => { e.preventDefault(); setQuery(search); }} className="flex items-end gap-2"><label className="flex-1">Find operator<input className={field} value={search} onChange={e => setSearch(e.target.value)} placeholder="Business, operator name or actor ID" maxLength={150} /></label><button disabled={busy} className="min-h-11 underline">Search</button></form>
      {truncated && <p className="text-sm">Showing the first 100 operators. Narrow your search.</p>}
      <label className="block">Operator<select disabled={busy} className={field} value={actor} onChange={e => setActor(e.target.value)}><option value="">Choose an operator</option>{actors.map(a => <option key={a.id} value={a.id}>{a.display_name || a.id} · {a.business_name || a.actor_type} · {a.status}</option>)}</select></label>
      {actor && <button disabled={busy} className="min-h-11 underline" onClick={reload}>Reload evidence</button>}
    </section>
    {actor && registry && <>
      <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-5 text-slate-900">
        <h2 className="font-semibold">Evidence records ({registry.evidence.length})</h2>
        <p className="text-sm">Revocation applies to one record. Another current, verified record for the same requirement can still satisfy it. Review all matching records. Expired records are evaluated by time even before a manual review.</p>
        {registry.evidence.map(e => <article key={e.id} className="rounded border border-slate-200 p-3 text-sm"><strong>{e.requirement_key}: {e.effective_status}</strong><p>{e.kind} · {e.scope || 'No scope restriction'} · {e.valid_until ? `Expires ${new Date(e.valid_until).toLocaleString()}` : 'No expiry recorded'}</p><p className="break-words">Evidence reference: {e.verified_source || 'Missing'}</p><button disabled={busy} className="min-h-11 underline" onClick={() => edit(e)}>Review {e.requirement_key} record {e.id.slice(0,8)}</button></article>)}
        <button disabled={busy} className="min-h-11 underline" onClick={reset}>Add separate evidence record</button>
        <form onSubmit={save}><fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-2 font-semibold">{version ? `Review record · version ${version}` : 'Register evidence'}</legend>
          <p className="text-sm sm:col-span-2">Check the document and its issuer outside this form. Record a private evidence reference and your decision. This form does not verify credentials with an issuer. Requirement keys, kind and scope must match the case requirements exactly. Dates use local time.</p>
          <label>Requirement key<input required maxLength={150} readOnly={Boolean(registry.evidence.find(e => e.id===id))} className={field} value={key} onChange={e => setKey(e.target.value)} /></label>
          <label>Kind<select disabled={busy || Boolean(registry.evidence.find(e => e.id===id))} className={field} value={kind} onChange={e => setKind(e.target.value)}>{kinds.map(k => <option key={k}>{k}</option>)}</select></label>
          <label>Scope (optional)<input maxLength={200} readOnly={Boolean(registry.evidence.find(e => e.id===id))} className={field} value={scope} onChange={e => setScope(e.target.value)} /></label>
          <label>Decision<select className={field} value={status} onChange={e => setStatus(e.target.value)}>{['unverified','verified','expired','revoked'].map(s => <option key={s}>{s}</option>)}</select></label>
          <label className="sm:col-span-2">Evidence source / reference<input required minLength={3} maxLength={500} className={field} value={source} onChange={e => setSource(e.target.value)} /></label>
          <label>Expires at<input type="datetime-local" required={!noExpiry} disabled={noExpiry} className={field} value={expiry} onChange={e => setExpiry(e.target.value)} /></label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={noExpiry} onChange={e => setNoExpiry(e.target.checked)} />Evidence has no recorded expiry</label>
          <label className="sm:col-span-2">Review reason<textarea required minLength={5} maxLength={500} className={field} value={reason} onChange={e => setReason(e.target.value)} /></label>
          <button className="min-h-11 rounded bg-slate-900 p-2 text-white">{busy ? 'Working…' : 'Record qualification review'}</button>
        </fieldset></form>
      </section>
      <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-5 text-slate-900"><h2 className="font-semibold">Check case qualifications</h2>
        <p className="text-sm">Checks explicitly registered requirements at the current time. Capacity, business authorization and other serviceability checks still apply. Cases with no registered requirements retain their previous workflow.</p>
        <form onSubmit={check} className="flex items-end gap-2"><label className="flex-1">Case ID<input required className={field} value={caseId} onChange={e => { setCaseId(e.target.value); setEvaluation(null); }} /></label><button disabled={busy} className="min-h-11 underline">Check requirements</button></form>
        {evaluation && <div role="status"><strong>{evaluation.evaluation.results.length ? evaluation.evaluation.decision : 'No qualification requirements registered'}</strong><ul>{evaluation.evaluation.results.map(r => <li key={r.requirementId}>{r.requirementId}: {r.satisfied ? 'Satisfied' : r.reason}</li>)}</ul></div>}
      </section>
      <section className="rounded-xl border border-slate-200 bg-white p-5 text-slate-900"><h2 className="font-semibold">Latest 100 reviews</h2><ul className="space-y-3 text-sm">{registry.history.map(h => <li key={h.id}><strong>{h.metadata.after.requirement_key}: {h.metadata.after.evidence_status}</strong><p>{h.metadata.after.review_reason}</p><p>{new Date(h.occurred_at).toLocaleString()} · Reviewer {h.principal_identity_id}</p></li>)}</ul></section>
    </>}
  </div>;
}
