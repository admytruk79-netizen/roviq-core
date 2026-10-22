import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

type Care = {
  history: { id: string; value: number; unit: string; source: string; recordedAt: string }[];
  reminders: { id: string; title: string; dueDate: string | null; dueOdometer: number | null; odometerUnit: string; completedAt: string | null; due: boolean }[];
};
const field = 'w-full rounded border border-slate-300 p-2 text-sm';

export function VehicleCarePanel({ vehicleId }: { vehicleId: string }) {
  const [care, setCare] = useState<Care | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [threshold, setThreshold] = useState('');
  const [reading, setReading] = useState('');
  const [readingUnit, setReadingUnit] = useState('miles');
  const [unit, setUnit] = useState('miles');
  const request = useRef<{ body: string; id: string } | null>(null);
  const base = `/api/me/vehicles/${vehicleId}`;
  const refresh = async () => setCare(await api.get<Care>(`${base}/care`));
  useEffect(() => {
    let active = true;
    api.get<Care>(`${base}/care`).then(r => { if (active) setCare(r); })
      .catch(() => { if (active) setError('Could not load vehicle care. Reopen this case to retry.'); });
    return () => { active = false; };
  }, [base]);
  async function save() {
    if (!title.trim() || (!date && !threshold)) { setError('Enter a service name and a date or odometer threshold.'); return; }
    if (threshold && (!Number.isInteger(Number(threshold)) || Number(threshold) < 0 || Number(threshold) > 2_000_000)) {
      setError('Enter a whole-number odometer threshold between 0 and 2,000,000.'); return;
    }
    const payload = { title: title.trim(), ...(date ? { dueDate: date } : {}),
      ...(threshold ? { dueOdometer: Number(threshold) } : {}), odometerUnit: unit };
    const body = JSON.stringify(payload);
    if (request.current?.body !== body) request.current = { body, id: crypto.randomUUID() };
    setBusy(true); setError('');
    try {
      await api.post(`${base}/reminders`, { id: request.current!.id, ...payload });
      await refresh();
      request.current = null; setTitle(''); setDate(''); setThreshold('');
    } catch { setError('Could not save the reminder. Retry with the same details.'); }
    finally { setBusy(false); }
  }
  async function record() {
    const value = Number(reading);
    if (!reading || !Number.isInteger(value) || value < 0 || value > 2_000_000) {
      setError('Enter the whole-number reading shown on the odometer (0 to 2,000,000).'); return;
    }
    setBusy(true); setError('');
    try { await api.patch(base, { odometerValue: value, odometerUnit: readingUnit }); await refresh(); setReading(''); }
    catch { setError('Could not save the odometer reading. Please retry.'); }
    finally { setBusy(false); }
  }
  async function complete(id: string) {
    setBusy(true); setError('');
    try { await api.post(`${base}/reminders/${id}/complete`); await refresh(); }
    catch { setError('Could not mark this reminder done. Please retry.'); }
    finally { setBusy(false); }
  }
  return <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4" aria-label="Vehicle care">
    <h2 className="font-semibold text-slate-800">Mileage and service reminders</h2>
    <p className="text-xs text-slate-500">Based on recorded readings and UTC calendar dates. Set intervals from your vehicle’s service schedule. Reminders appear here; external notifications are not enabled.</p>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {!care && !error && <p role="status" className="text-sm">Loading vehicle care…</p>}
    {care && <>
      <fieldset disabled={busy} className="space-y-2">
        <legend className="text-sm font-medium">Record the displayed odometer</legend>
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-sm">Current reading<input type="number" min="0" max="2000000" step="1" className={field} value={reading} onChange={e => setReading(e.target.value)} /></label>
          <label className="block text-sm">Odometer unit<select className={field} value={readingUnit} onChange={e => setReadingUnit(e.target.value)}><option value="miles">Miles</option><option value="kilometers">Kilometres</option></select></label>
        </div>
        <button type="button" onClick={record} className="min-h-11 underline">Save reading</button>
      </fieldset>
      <details><summary className="cursor-pointer text-sm font-medium">Recent odometer history ({care.history.length}, latest 50)</summary>
        <p className="mt-2 text-xs text-slate-500">Reported values may include corrections. Earlier values are retained. Baseline entries were imported when history was enabled.</p>
        {!care.history.length && <p className="text-sm">No reading recorded yet. Ask your technician to record the odometer during the vehicle check.</p>}
        <ul className="mt-2 space-y-1 text-sm">{care.history.map(h => <li key={h.id}>{h.value.toLocaleString()} {h.unit} · {new Date(h.recordedAt).toLocaleString()} · {h.source.replaceAll('_', ' ')}</li>)}</ul>
      </details>
      <ul className="space-y-2">{care.reminders.filter(r => !r.completedAt).map(r => <li key={r.id} className="rounded border border-slate-200 p-3 text-sm">
        <p className="font-medium">{r.title} {r.due && <strong className="text-amber-800">— Due</strong>}</p>
        <p>{[r.dueDate && `By ${r.dueDate} (UTC)`, r.dueOdometer !== null && `At ${r.dueOdometer.toLocaleString()} ${r.odometerUnit}`].filter(Boolean).join(' or ')}</p>
        <button type="button" disabled={busy} onClick={() => complete(r.id)} className="mt-1 min-h-11 underline disabled:opacity-50">Mark done</button>
      </li>)}</ul>
      <fieldset disabled={busy} className="space-y-2">
        <legend className="text-sm font-medium">Add a service reminder</legend>
        <label className="block text-sm">Service name<input className={field} maxLength={120} value={title} onChange={e => setTitle(e.target.value)} placeholder="Oil service" /></label>
        <label className="block text-sm">Due date (optional)<input type="date" className={field} value={date} onChange={e => setDate(e.target.value)} /></label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-sm">Odometer threshold (optional)<input type="number" min="0" max="2000000" step="1" className={field} value={threshold} onChange={e => setThreshold(e.target.value)} /></label>
          <label className="block text-sm">Threshold unit<select className={field} value={unit} onChange={e => setUnit(e.target.value)}><option value="miles">Miles</option><option value="kilometers">Kilometres</option></select></label>
        </div>
        <button type="button" onClick={save} className="min-h-11 rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50">{busy ? 'Saving…' : 'Save reminder'}</button>
      </fieldset>
    </>}
  </section>;
}
