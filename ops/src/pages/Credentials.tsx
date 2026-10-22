import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { QUALIFICATION_KINDS, QUALIFICATION_PRESETS, kindLabel, type QualificationKind } from '../lib/qualifications';

// Technician and shop credentials (training, OEM certifications, licences, equipment). A credential
// only counts once Ops records where it was verified. Credentials are never deleted: revoke or
// expire them, so past assignments stay explainable.

type Actor = { id: string; actor_type: string; status: string; attributes?: Record<string, unknown> };
type Evidence = { id: string; requirement_key: string; kind: string; scope: string | null; evidence_status: 'verified' | 'unverified' | 'expired' | 'revoked'; verified_source: string | null; valid_until: string | null; updated_at: string };

const field = 'mt-1 w-full rounded border border-slate-300 bg-white p-2 text-sm text-slate-900';
const TYPES = ['diagnostic', 'shop', 'tow', 'partner', 'parts', 'fleet'];
const STATUS_TONE: Record<string, string> = { verified: 'text-emerald-700', unverified: 'text-amber-700', expired: 'text-red-600', revoked: 'text-red-600' };

function actorName(a: Actor) {
  const v = a.attributes ?? {};
  const name = [v.displayName, v.name, v.businessName].find((x) => typeof x === 'string');
  return typeof name === 'string' && name.trim() ? name : `${a.actor_type} ${a.id.slice(0, 8)}`;
}

function current(e: Evidence) {
  return e.evidence_status === 'verified' && (!e.valid_until || Date.parse(e.valid_until) > Date.now());
}

export function Credentials() {
  const [actorType, setActorType] = useState('diagnostic');
  const [actors, setActors] = useState<Actor[]>([]);
  const [actorId, setActorId] = useState('');
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [preset, setPreset] = useState('');
  const [key, setKey] = useState('');
  const [kind, setKind] = useState<QualificationKind>('training');
  const [scope, setScope] = useState('');
  const [source, setSource] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    api.get<{ actors: Actor[] }>(`/api/admin/actors?actorType=${actorType}&status=active`)
      .then((r) => { setActors(r.actors); setActorId(''); setEvidence([]); })
      .catch(() => setError('Could not load accounts.'));
  }, [actorType]);

  const loadEvidence = useCallback(async (id: string) => {
    if (!id) { setEvidence([]); return; }
    try { setEvidence((await api.get<{ evidence: Evidence[] }>(`/api/admin/actors/${id}/qualification-evidence`)).evidence); }
    catch { setError('Could not load credentials.'); }
  }, []);
  useEffect(() => { void loadEvidence(actorId); }, [actorId, loadEvidence]);

  function choosePreset(value: string) {
    setPreset(value);
    const p = QUALIFICATION_PRESETS.find((x) => x.key === value);
    if (p) { setKey(p.key); setKind(p.kind); }
  }

  async function record(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(''); setNotice('');
    try {
      await api.post(`/api/admin/actors/${actorId}/qualification-evidence`, {
        requirementKey: key.trim(), kind, scope: scope.trim() || undefined, status: 'verified', verifiedSource: source.trim(),
        ...(validUntil ? { validUntil: new Date(validUntil).toISOString() } : {})
      });
      setPreset(''); setKey(''); setScope(''); setSource(''); setValidUntil('');
      setNotice('Credential recorded. It counts for new assignments straight away.');
      await loadEvidence(actorId);
    } catch (err) {
      const code = err instanceof ApiError ? err.message : '';
      setError(code === 'evidence_already_expired' ? 'That expiry date has already passed.' : 'Could not record the credential. Check the key and the verification reference.');
    } finally { setBusy(false); }
  }

  async function change(item: Evidence, status: 'expired' | 'revoked') {
    setBusy(true); setError(''); setNotice('');
    try { await api.patch(`/api/admin/actors/${actorId}/qualification-evidence/${item.id}`, { status }); await loadEvidence(actorId); setNotice(`Credential marked ${status}. Cases that require it will no longer go to this account.`); }
    catch { setError('Could not update the credential.'); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold">Credentials</h1>
      <p className="text-sm text-slate-500">Training, certifications, licences and equipment held by technicians and shops. When a case lists job requirements, only accounts with current verified credentials for them can be offered, see or claim it. Recording a credential here records your check; it does not verify it with the issuer.</p>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {notice && <p role="status" className="text-sm text-emerald-600">{notice}</p>}
      <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-5 text-slate-900">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">Account type<select id="cred-type" className={field} value={actorType} onChange={(e) => setActorType(e.target.value)}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select></label>
          <label className="text-sm">Account<select id="cred-actor" className={field} value={actorId} onChange={(e) => setActorId(e.target.value)}><option value="">Choose an account</option>{actors.map((a) => <option key={a.id} value={a.id}>{actorName(a)}</option>)}</select></label>
        </div>
        {actorId && (
          <>
            <h2 className="pt-2 font-semibold">{evidence.filter(current).length} current credentials</h2>
            {evidence.length === 0 && <p className="text-sm text-slate-500">No credentials recorded yet.</p>}
            <ul className="space-y-2 text-sm">
              {evidence.map((e) => (
                <li key={e.id} className="flex flex-wrap items-start justify-between gap-2 rounded border border-slate-200 p-3">
                  <div>
                    <b>{QUALIFICATION_PRESETS.find((p) => p.key === e.requirement_key)?.label ?? e.requirement_key}</b> · {kindLabel(e.kind)}{e.scope ? ` · ${e.scope}` : ''}
                    <p><span className={STATUS_TONE[e.evidence_status]}>{e.evidence_status === 'verified' && !current(e) ? 'expired' : e.evidence_status}</span>{e.valid_until ? ` · valid until ${new Date(e.valid_until).toLocaleDateString()}` : ' · no expiry'}</p>
                    {e.verified_source && <p className="text-slate-500">Verified from: {e.verified_source}</p>}
                  </div>
                  {e.evidence_status === 'verified' && (
                    <div className="flex gap-2">
                      <button type="button" className="roviq-btn-secondary" disabled={busy} onClick={() => void change(e, 'expired')}>Mark expired</button>
                      <button type="button" className="roviq-btn-secondary" disabled={busy} onClick={() => void change(e, 'revoked')}>Revoke</button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <form onSubmit={record}><fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
              <legend className="mb-2 font-semibold">Record a verified credential</legend>
              <label className="text-sm">Common credential<select id="cred-preset" className={field} value={preset} onChange={(e) => choosePreset(e.target.value)}><option value="">Choose, or type your own below</option>{QUALIFICATION_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select></label>
              <label className="text-sm">Credential key<input id="cred-key" required className={field} value={key} onChange={(e) => setKey(e.target.value)} placeholder="must match the job requirement key" /></label>
              <label className="text-sm">Type<select id="cred-kind" className={field} value={kind} onChange={(e) => setKind(e.target.value as QualificationKind)}>{QUALIFICATION_KINDS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select></label>
              <label className="text-sm">Scope (optional)<input id="cred-scope" className={field} value={scope} onChange={(e) => setScope(e.target.value)} placeholder="must match the requirement's scope" /></label>
              <label className="text-sm">Verified from<input id="cred-source" required minLength={3} maxLength={300} className={field} value={source} onChange={(e) => setSource(e.target.value)} placeholder="e.g. ASE certificate #, issuer portal check" /></label>
              <label className="text-sm">Valid until (optional)<input id="cred-until" type="date" className={field} value={validUntil} onChange={(e) => setValidUntil(e.target.value)} /></label>
              <div className="sm:col-span-2"><button type="submit" className="roviq-btn-primary">{busy ? 'Saving…' : 'Record credential'}</button></div>
            </fieldset></form>
          </>
        )}
      </section>
    </div>
  );
}
