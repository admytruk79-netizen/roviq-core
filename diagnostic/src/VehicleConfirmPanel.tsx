import { useEffect, useState, type FormEvent } from 'react';

// The on-site check of the vehicle on the case: the technician corrects what the customer
// entered, adds VIN and odometer, and confirms it. Core then shares the confirmed vehicle with
// tow, shop and parts at the level each needs.

type Vehicle = {
  id: string; verified: boolean; year: number | null; make: string | null; model: string | null; trim: string | null;
  vin?: string | null; color?: string | null; licensePlate?: string | null; plateRegion?: string | null;
  drivetrain?: string | null; fuelType?: string | null; engine?: string | null; odometerValue?: number | null;
};

const BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');
const TOKEN = 'roviq_diagnostic_token';

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem(TOKEN);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : `request_failed_${res.status}`);
  return body as T;
}

const MESSAGES: Record<string, string> = {
  vehicle_vin_conflict: 'That VIN already belongs to another customer’s vehicle. Check it, or tell ROVIQ Ops.',
  vehicle_details_required: 'Enter at least year, make and model.',
  forbidden: 'You are not assigned to this case.'
};

function formFor(v: Vehicle | null): Record<string, string> {
  return {
    year: v?.year?.toString() ?? '', make: v?.make ?? '', model: v?.model ?? '', trim: v?.trim ?? '', vin: v?.vin ?? '',
    odometerValue: v?.odometerValue?.toString() ?? '', color: v?.color ?? '', licensePlate: v?.licensePlate ?? '',
    drivetrain: v?.drivetrain ?? '', fuelType: v?.fuelType ?? '', engine: v?.engine ?? ''
  };
}

function title(v: Vehicle | null) {
  return v ? [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ') || 'Vehicle' : 'No vehicle on this case yet';
}

export function VehicleConfirmPanel({ caseId }: { caseId: string }) {
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState<Record<string, string>>({});

  useEffect(() => {
    let live = true;
    call<{ vehicle: Vehicle | null }>(`/api/maintenance/cases/${caseId}/vehicle`)
      .then((r) => {
        if (!live) return;
        setVehicle(r.vehicle);
        // No vehicle on the case yet: open the form so the technician can record it.
        if (!r.vehicle) { setForm(formFor(null)); setEditing(true); }
      })
      .catch(() => { if (live) setError('Could not load the vehicle.'); })
      .finally(() => { if (live) setLoaded(true); });
    return () => { live = false; };
  }, [caseId]);

  function start() {
    setForm(formFor(vehicle));
    setError('');
    setEditing(true);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const payload: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(form)) {
      const value = raw.trim();
      if (!value) continue;
      payload[key] = key === 'year' || key === 'odometerValue' ? Number(value) : value;
    }
    try {
      const r = await call<{ vehicle: Vehicle }>(`/api/maintenance/cases/${caseId}/vehicle/confirm`, { method: 'POST', body: JSON.stringify(payload) });
      setVehicle(r.vehicle);
      setEditing(false);
    } catch (err) {
      const code = err instanceof Error ? err.message : '';
      setError(MESSAGES[code] ?? (code.startsWith('request_failed_400') ? 'Check the details: a VIN is 17 letters and digits (no I, O or Q).' : 'Could not confirm the vehicle. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return null;
  const field = (key: string, label: string, props: Record<string, unknown> = {}) => (
    <label>{label}<input value={form[key] ?? ''} onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} {...props} /></label>
  );

  return (
    <section className="panel form vehicle-confirm" aria-labelledby="vehicle-confirm-heading">
      <div className="form-head">
        <div>
          <span className="eyebrow">Vehicle</span>
          <h2 id="vehicle-confirm-heading">{title(vehicle)}</h2>
          {vehicle && <p>{[vehicle.color, vehicle.licensePlate, vehicle.vin && `VIN ${vehicle.vin}`, vehicle.odometerValue != null && `${vehicle.odometerValue.toLocaleString()} mi`].filter(Boolean).join(' · ') || 'No details yet'}</p>}
        </div>
        <span className="pill">{vehicle?.verified ? 'Confirmed' : 'Not confirmed'}</span>
      </div>
      {!editing && (
        <div className="actions">
          <button type="button" className={vehicle?.verified ? 'secondary' : 'primary'} onClick={start}>{vehicle?.verified ? 'Update vehicle' : 'Check & confirm vehicle'}</button>
        </div>
      )}
      {editing && (
        <form onSubmit={submit} aria-busy={busy}>
          <p className="hint">Match the vehicle in front of you. VIN is on the dashboard at the windshield or the driver’s door frame.</p>
          <div className="form-grid">
            {field('year', 'Year', { inputMode: 'numeric', required: !vehicle })}
            {field('make', 'Make', { required: !vehicle })}
            {field('model', 'Model', { required: !vehicle })}
            {field('trim', 'Trim')}
            {field('vin', 'VIN', { maxLength: 20, autoCapitalize: 'characters', spellCheck: false })}
            {field('odometerValue', 'Odometer (mi)', { inputMode: 'numeric' })}
            {field('color', 'Color')}
            {field('licensePlate', 'License plate', { autoCapitalize: 'characters' })}
            {field('engine', 'Engine', { placeholder: '2.5L I4' })}
            <label>Drive<select value={form.drivetrain ?? ''} onChange={(e) => setForm((f) => ({ ...f, drivetrain: e.target.value }))}><option value="">Not sure</option><option value="fwd">Front-wheel</option><option value="rwd">Rear-wheel</option><option value="awd">All-wheel</option><option value="4wd">4×4</option></select></label>
            <label>Fuel<select value={form.fuelType ?? ''} onChange={(e) => setForm((f) => ({ ...f, fuelType: e.target.value }))}><option value="">Not sure</option><option value="gasoline">Gas</option><option value="diesel">Diesel</option><option value="hybrid">Hybrid</option><option value="plug_in_hybrid">Plug-in hybrid</option><option value="electric">Electric</option><option value="other">Other</option></select></label>
          </div>
          {error && <div className="error" role="alert">{error}</div>}
          <div className="actions">
            <button className="primary" disabled={busy} aria-busy={busy}>{busy ? 'Saving…' : 'Confirm vehicle'}</button>
            {vehicle && <button type="button" className="secondary" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>}
          </div>
        </form>
      )}
      {!editing && error && <div className="error" role="alert">{error}</div>}
    </section>
  );
}
