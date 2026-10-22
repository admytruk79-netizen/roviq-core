import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { QUALIFICATION_KINDS, QUALIFICATION_PRESETS, kindLabel, type QualificationKind } from '../lib/qualifications';

// What this job requires (EV training, OEM access, equipment...). With requirements set, only
// technicians holding current verified credentials can be offered, see or claim the case.

type Requirement = { requirement_key: string; kind: string; scope: string | null; mandatory: boolean };
type Candidate = { actorId: string; name: string | null; decision: 'eligible' | 'blocked' | 'review_required'; blockingReasons: string[]; reviewReasons: string[] };

const field = 'mt-1 w-full rounded border border-slate-300 bg-white p-2 text-sm text-slate-900';
const DECISION = { eligible: ['Qualified', 'text-emerald-700'], review_required: ['Needs review', 'text-amber-700'], blocked: ['Missing credentials', 'text-red-600'] } as const;

function gapLabel(reason: string) {
  const [, key, why] = reason.split(':');
  return `${key} (${(why ?? '').replaceAll('_', ' ')})`;
}

export function CaseQualifications({ caseId }: { caseId: string }) {
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [actorType, setActorType] = useState('diagnostic');
  const [preset, setPreset] = useState('');
  const [key, setKey] = useState('');
  const [kind, setKind] = useState<QualificationKind>('training');
  const [scope, setScope] = useState('');
  const [mandatory, setMandatory] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [r, c] = await Promise.all([
        api.get<{ requirements: Requirement[] }>(`/api/admin/cases/${caseId}/qualifications`),
        api.get<{ candidates: Candidate[] }>(`/api/admin/cases/${caseId}/qualifications/candidates?actorType=${actorType}`)
      ]);
      setRequirements(r.requirements);
      setCandidates(c.candidates);
    } catch { setError('Could not load job requirements.'); }
  }, [caseId, actorType]);
  useEffect(() => { void load(); }, [load]);

  function choosePreset(value: string) {
    setPreset(value);
    const p = QUALIFICATION_PRESETS.find((x) => x.key === value);
    if (p) { setKey(p.key); setKind(p.kind); }
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await api.put(`/api/admin/cases/${caseId}/qualifications`, { requirementKey: key.trim(), kind, scope: scope.trim() || undefined, mandatory });
      setPreset(''); setKey(''); setScope('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 400 ? 'Use a key of lowercase letters, digits and _ . : -' : 'Could not save the requirement.');
    } finally { setBusy(false); }
  }

  async function remove(requirementKey: string) {
    setBusy(true); setError('');
    try { await api.delete(`/api/admin/cases/${caseId}/qualifications/${encodeURIComponent(requirementKey)}`); await load(); }
    catch { setError('Could not remove the requirement.'); }
    finally { setBusy(false); }
  }

  const qualified = candidates?.filter((c) => c.decision !== 'blocked').length ?? 0;
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4" aria-labelledby="job-requirements-heading">
      <h2 id="job-requirements-heading" className="text-sm font-semibold text-slate-700">Job requirements</h2>
      <p className="mt-1 text-sm text-slate-500">
        {requirements.length
          ? 'Only technicians with current, verified credentials for every required item can be offered, see or claim this case.'
          : 'No requirements set: any active technician with the right service can take this case.'}
      </p>
      {requirements.length > 0 && (
        <ul className="mt-3 divide-y divide-slate-200 rounded border border-slate-200">
          {requirements.map((r) => (
            <li key={r.requirement_key} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
              <span><b>{QUALIFICATION_PRESETS.find((p) => p.key === r.requirement_key)?.label ?? r.requirement_key}</b> · {kindLabel(r.kind)}{r.scope ? ` · ${r.scope}` : ''}{r.mandatory ? '' : ' · optional (review)'}</span>
              <button type="button" className="roviq-btn-secondary" disabled={busy} onClick={() => void remove(r.requirement_key)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-sm">Common requirement
          <select id="req-preset" className={field} value={preset} onChange={(e) => choosePreset(e.target.value)}>
            <option value="">Choose, or type your own below</option>
            {QUALIFICATION_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        </label>
        <label className="text-sm">Requirement key
          <input id="req-key" required className={field} value={key} onChange={(e) => setKey(e.target.value)} placeholder="e.g. ev_high_voltage" />
        </label>
        <label className="text-sm">Type
          <select id="req-kind" className={field} value={kind} onChange={(e) => setKind(e.target.value as QualificationKind)}>
            {QUALIFICATION_KINDS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </label>
        <label className="text-sm">Scope (optional)
          <input id="req-scope" className={field} value={scope} onChange={(e) => setScope(e.target.value)} placeholder="e.g. Tesla, Ontario" />
        </label>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input id="req-mandatory" type="checkbox" checked={mandatory} onChange={(e) => setMandatory(e.target.checked)} />
          Required (unchecked: missing it sends the assignment to review instead of blocking)
        </label>
        <div className="sm:col-span-2"><button type="submit" className="roviq-btn-primary" disabled={busy || !key.trim()}>{busy ? 'Saving…' : 'Add requirement'}</button></div>
      </form>
      {error && <p className="mt-2 text-sm text-red-600" role="alert">{error}</p>}
      {requirements.length > 0 && candidates && (
        <div className="mt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-700">Who qualifies · {qualified} of {candidates.length}</h3>
            <label className="text-sm">Show
              <select id="req-actor-type" className="ml-2 rounded border border-slate-300 bg-white p-1 text-sm text-slate-900" value={actorType} onChange={(e) => setActorType(e.target.value)}>
                {['diagnostic', 'shop', 'tow', 'partner'].map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
          </div>
          <ul className="mt-2 space-y-1 text-sm">
            {candidates.map((c) => {
              const [label, tone] = DECISION[c.decision];
              const gaps = [...c.blockingReasons, ...c.reviewReasons];
              return <li key={c.actorId}><span className="text-slate-700">{c.name ?? c.actorId.slice(0, 8)}</span> · <span className={tone}>{label}</span>{gaps.length > 0 && <span className="text-slate-500">: {gaps.map(gapLabel).join(', ')}</span>}</li>;
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
