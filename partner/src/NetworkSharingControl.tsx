import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from './api';

// Your parts are private until you choose otherwise. This panel sets who in the ROVIQ network can
// see that you stock a part (and whether they see how many), and which partners may ask ROVIQ to
// source your parts for their jobs.

type Policy = { visibility: 'private' | 'same_organization' | 'named_partners' | 'network'; detail: 'availability_only' | 'quantity' };
type Permission = { grantee_actor_id: string; grantee_name: string | null; resource_type: string; can_view: boolean; can_request_transfer: boolean };

const VISIBILITY: { value: Policy['visibility']; label: string; hint: string }[] = [
  { value: 'private', label: 'Private', hint: 'Only you. ROVIQ never shows or uses your parts for other businesses.' },
  { value: 'same_organization', label: 'My dealer group', hint: 'Other locations in your own organization.' },
  { value: 'named_partners', label: 'Named partners', hint: 'Only the partners you list below.' },
  { value: 'network', label: 'Whole ROVIQ network', hint: 'Any participating business can see availability.' }
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ERRORS: Record<string, string> = {
  grantee_not_found: 'No active ROVIQ business has that partner ID.',
  cannot_grant_self: 'You cannot add your own business.'
};

export function NetworkSharingControl() {
  const [policy, setPolicy] = useState<Policy>({ visibility: 'private', detail: 'availability_only' });
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState('');
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [partnerId, setPartnerId] = useState('');
  const [canTransfer, setCanTransfer] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, g] = await Promise.all([
        api.get<{ policies: { parts: Policy } }>('/api/partners/me/inventory-policies'),
        api.get<{ permissions: Permission[] }>('/api/partners/me/transfer-permissions')
      ]);
      setPolicy({ visibility: p.policies.parts.visibility, detail: p.policies.parts.detail });
      setPermissions(g.permissions.filter((x) => x.resource_type === 'parts'));
    } catch {
      setMessage({ text: 'Could not load your sharing settings.', error: true });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function savePolicy() {
    setSaving('policy');
    setMessage(null);
    try {
      await api.put('/api/partners/me/inventory-policies/parts', policy);
      setMessage({ text: 'Parts sharing saved.', error: false });
    } catch {
      setMessage({ text: 'Could not save parts sharing.', error: true });
    } finally {
      setSaving('');
    }
  }

  async function addPartner(event: FormEvent) {
    event.preventDefault();
    const id = partnerId.trim();
    if (!UUID_RE.test(id)) { setMessage({ text: 'Enter the partner’s ROVIQ ID (from ROVIQ Ops).', error: true }); return; }
    setSaving('grant');
    setMessage(null);
    try {
      await api.put(`/api/partners/me/transfer-permissions/${id}/parts`, { canView: true, canRequestTransfer: canTransfer });
      setPartnerId('');
      setCanTransfer(false);
      await load();
      setMessage({ text: 'Partner added.', error: false });
    } catch (err) {
      const code = err instanceof Error ? err.message : '';
      setMessage({ text: ERRORS[code] ?? 'Could not add that partner.', error: true });
    } finally {
      setSaving('');
    }
  }

  async function updatePartner(p: Permission, transfer: boolean) {
    setSaving(p.grantee_actor_id);
    try {
      await api.put(`/api/partners/me/transfer-permissions/${p.grantee_actor_id}/parts`, { canView: true, canRequestTransfer: transfer });
      await load();
    } catch {
      setMessage({ text: 'Could not update that partner.', error: true });
    } finally {
      setSaving('');
    }
  }

  async function removePartner(p: Permission) {
    setSaving(p.grantee_actor_id);
    try {
      await api.del(`/api/partners/me/transfer-permissions/${p.grantee_actor_id}/parts`);
      await load();
    } catch {
      setMessage({ text: 'Could not remove that partner.', error: true });
    } finally {
      setSaving('');
    }
  }

  const selected = VISIBILITY.find((v) => v.value === policy.visibility)!;

  return (
    <section className="mt-8" aria-labelledby="network-sharing-heading">
      <div className="mb-4">
        <p className="kicker">Network sharing</p>
        <h2 id="network-sharing-heading" className="mt-1 text-2xl font-bold">Your parts in the ROVIQ network</h2>
        <p className="muted mt-1 max-w-2xl text-sm">Your stock is private unless you share it. Seeing a part never lets another business take it: ROVIQ only sources your parts for partners you allow to request transfers, and you still accept each order.</p>
      </div>
      {message && <div className={`mb-4 rounded-xl border px-4 py-3 text-sm ${message.error ? 'border-red-400/25 bg-red-500/10 text-red-100' : 'border-white/10 bg-white/[.035] text-white/85'}`} role={message.error ? 'alert' : 'status'}>{message.text}</div>}
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="panel p-5" aria-busy={loading}>
          <h3 className="text-lg font-bold">Who can see your parts</h3>
          <fieldset className="mt-4 space-y-2" disabled={loading || saving === 'policy'}>
            <legend className="sr-only">Parts visibility</legend>
            {VISIBILITY.map((v) => (
              <label key={v.value} className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 text-sm ${policy.visibility === v.value ? 'border-[var(--green)]/40 bg-white/[.04]' : 'border-white/10'}`}>
                <input type="radio" name="parts-visibility" className="mt-1" checked={policy.visibility === v.value} onChange={() => setPolicy((p) => ({ ...p, visibility: v.value }))} />
                <span><span className="font-semibold">{v.label}</span><span className="muted block text-xs">{v.hint}</span></span>
              </label>
            ))}
            {policy.visibility !== 'private' && (
              <label className="flex min-h-11 items-center gap-3 text-sm">
                <input type="checkbox" checked={policy.detail === 'quantity'} onChange={(e) => setPolicy((p) => ({ ...p, detail: e.target.checked ? 'quantity' : 'availability_only' }))} />
                Show how many I have (otherwise only “in stock”)
              </label>
            )}
          </fieldset>
          <p className="muted mt-3 text-xs">Currently: {selected.label}{policy.visibility !== 'private' ? (policy.detail === 'quantity' ? ', with quantities' : ', availability only') : ''}.</p>
          <button type="button" className="primary mt-4 w-full" disabled={loading || saving === 'policy'} aria-busy={saving === 'policy'} onClick={() => void savePolicy()}>{saving === 'policy' ? 'Saving…' : 'Save parts sharing'}</button>
        </div>

        <div className="panel p-5">
          <h3 className="text-lg font-bold">Partners</h3>
          <p className="muted mt-1 text-sm">Named partners can see your parts. Turn on transfers to let ROVIQ source your parts for their jobs.</p>
          <ul className="mt-4 space-y-2">
            {!loading && permissions.length === 0 && <li className="muted text-sm">No partners added.</li>}
            {permissions.map((p) => (
              <li key={p.grantee_actor_id} className="flex flex-col gap-2 rounded-xl border border-white/10 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="truncate font-semibold">{p.grantee_name ?? `Partner ${p.grantee_actor_id.slice(0, 8)}`}</p>
                  <p className="muted text-xs">{p.can_request_transfer ? 'Can see and request transfers' : 'Can see only'}</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button type="button" className="secondary px-3 py-2 text-xs" disabled={saving === p.grantee_actor_id} aria-pressed={p.can_request_transfer} onClick={() => void updatePartner(p, !p.can_request_transfer)}>{p.can_request_transfer ? 'Stop transfers' : 'Allow transfers'}</button>
                  <button type="button" className="danger px-3 py-2 text-xs" disabled={saving === p.grantee_actor_id} onClick={() => void removePartner(p)}>Remove</button>
                </div>
              </li>
            ))}
          </ul>
          <form className="mt-5 space-y-3" onSubmit={addPartner}>
            <label className="block text-sm"><span className="muted">Partner ROVIQ ID</span><input className="input mt-1 w-full font-mono text-sm" value={partnerId} onChange={(e) => setPartnerId(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" spellCheck={false} /></label>
            <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={canTransfer} onChange={(e) => setCanTransfer(e.target.checked)} />Allow this partner to request transfers</label>
            <button type="submit" className="secondary w-full" disabled={saving === 'grant'} aria-busy={saving === 'grant'}>{saving === 'grant' ? 'Adding…' : 'Add partner'}</button>
          </form>
        </div>
      </div>
    </section>
  );
}
