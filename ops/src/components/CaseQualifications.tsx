import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { QUALIFICATION_KINDS, QUALIFICATION_PRESETS, kindLabel, type QualificationKind } from '../lib/qualifications';

// What this job requires (EV training, OEM access, equipment...). With requirements set, only
// technicians holding current verified credentials can be offered, see or claim the case.
// Requirements are written through the audited qualification admin API (named admin, reason,
// closed once a provider is selected); credentials are reviewed on the Qualifications page.

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
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [r, c] = await Promise.all([
        api.get<{ requirements: Requirement[] }>(`/api/admin/qualifications/cases/${caseId}/requirements`),
        api.get<{ candidates: Candidate[] }>(`/api/admin/qualifications/cases/${caseId}/candidates?actorType=${actorType}`)
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
      await api.put(`/api/admin/qualifications/cases/${caseId}/requirements/${encodeURIComponent(key.trim())}`, { kind, scope: scope.trim() || null, mandatory, reason: reason.trim() });
      setPreset(''); setKey(''); setScope(''); setReason('');
      await load();
    } catch (err) {
      const code = err instanceof ApiError ? err.message : '';
      setError(code === 'case_not_open_for_requirements' ? 'A provider is already selected or the case has moved on. Change requirements through a case exception instead.'
        : code === 'identified_admin_required' ? 'Sign in with your own admin account to change requirements.'
        : 'Could not save the requirement. Check the key and give a reason of at least 5 characters.');
    } finally { setBusy(false); }
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
            <li key={r.requirement_key} className="px-3 py-2 text-sm">
              <b>{QUALIFICATION_PRESETS.find((p) => p.key === r.requirement_key)?.label ?? r.requirement_key}</b> · {kindLabel(r.kind)}{r.scope ? ` · ${r.scope}` : ''}{r.mandatory ? '' : ' · optional (review)'}
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
        <label className="text-sm sm:col-span-2">Reason
          <input id="req-reason" required minLength={5} maxLength={500} className={field} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. EV high-voltage work on a 2015 Leaf" />
        </label>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input id="req-mandatory" type="checkbox" checked={mandatory} onChange={(e) => setMandatory(e.target.checked)} />
          Required (unchecked: missing it sends the assignment to review instead of blocking). Re-saving a key updates it.
        </label>
        <div className="sm:col-span-2"><button type="submit" className="roviq-btn-primary" disabled={busy || !key.trim() || reason.trim().length < 5}>{busy ? 'Saving…' : 'Save requirement'}</button></div>
        <p className="text-xs text-slate-500 sm:col-span-2">Credentials are reviewed on the Qualifications page; their keys, type and scope must match these exactly.</p>
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
