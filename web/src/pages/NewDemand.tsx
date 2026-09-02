import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import type { ServiceCase } from '../lib/types';

const ISSUE_TYPES: { value: string; label: string }[] = [
  { value: 'brake_repair', label: 'Brakes' },
  { value: 'wont_start', label: "Won't start" },
  { value: 'oil_change', label: 'Oil change' },
  { value: 'check_engine_light', label: 'Check engine light' },
  { value: 'flat_tire', label: 'Flat tire' },
  { value: 'battery', label: 'Battery' },
  { value: 'ac_heating', label: 'AC / heating' },
  { value: 'transmission', label: 'Transmission' },
  { value: 'other', label: 'Something else' }
];

type IntakeLocation = { lat: number; lng: number; accuracy?: number; capturedAt: string };

function currentLocation(): Promise<IntakeLocation | null> {
  if (!navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : undefined,
        capturedAt: new Date(position.timestamp || Date.now()).toISOString()
      }),
      () => resolve(null),
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 12_000 }
    );
  });
}

export function NewDemand() {
  const [issueType, setIssueType] = useState('');
  const [otherIssue, setOtherIssue] = useState('');
  const [description, setDescription] = useState('');
  const [urgency, setUrgency] = useState<'normal' | 'urgent' | 'emergency'>('normal');
  const [location, setLocation] = useState<IntakeLocation | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationMessage, setLocationMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  async function captureLocation() {
    setLocating(true);
    setLocationMessage('');
    const next = await currentLocation();
    if (next) {
      setLocation(next);
      const accuracy = typeof next.accuracy === 'number' ? ` · ±${Math.round(next.accuracy)} m` : '';
      setLocationMessage(`Vehicle GPS captured${accuracy}.`);
    } else {
      setLocation(null);
      setLocationMessage('Location permission or GPS is unavailable. Enable precise location to create a dispatch-ready case.');
    }
    setLocating(false);
    return next;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const demandType = issueType === 'other' ? otherIssue.trim().toLowerCase().replace(/\s+/g, '_') : issueType;
      const intakeLocation = location ?? await captureLocation();
      if (!intakeLocation) {
        setError('Vehicle GPS is required so diagnostics and Tow / Valet can find the case location. Enable location permission and try again.');
        setSubmitting(false);
        return;
      }
      const res = await api.post<{ case: ServiceCase }>('/api/demands', {
        domain: 'maintenance',
        demandType,
        location: intakeLocation,
        urgency,
        attributes: description.trim() ? { description: description.trim() } : {}
      });
      navigate(`/cases/${res.case.id}`);
    } catch {
      setError('Could not submit your request. Please try again.');
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-lg space-y-4">
      <h1 className="text-lg font-semibold">Report a new issue</h1>
      <form onSubmit={handleSubmit} className="space-y-4 rounded-lg border border-slate-200 bg-white p-6">
        <div>
          <label className="block text-sm font-medium text-slate-700" htmlFor="issueType">
            What's going on with your vehicle?
          </label>
          <select
            id="issueType"
            required
            value={issueType}
            onChange={(e) => setIssueType(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
          >
            <option value="" disabled>Select an issue…</option>
            {ISSUE_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>
        {issueType === 'other' && (
          <div>
            <label className="block text-sm font-medium text-slate-700" htmlFor="otherIssue">Briefly, what's the issue?</label>
            <input
              id="otherIssue"
              required
              value={otherIssue}
              onChange={(e) => setOtherIssue(e.target.value)}
              placeholder="e.g. strange noise when braking"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
            />
          </div>
        )}
        <div>
          <label className="block text-sm font-medium text-slate-700" htmlFor="description">
            Anything else worth knowing? <span className="font-normal text-slate-400">(optional)</span>
          </label>
          <textarea
            id="description"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. it started last week, gets worse on the highway"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
          />
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-slate-700">Vehicle GPS</p>
              <p className="mt-0.5 text-xs text-slate-500">Required for diagnostic dispatch and Tow / Valet routing.</p>
            </div>
            <button
              type="button"
              onClick={() => void captureLocation()}
              disabled={locating}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
            >
              {locating ? 'Locating…' : location ? 'Update GPS' : 'Capture GPS'}
            </button>
          </div>
          {location && <p className="mt-2 text-xs text-emerald-700">GPS ready for dispatch.</p>}
          {locationMessage && <p className="mt-2 text-xs text-slate-500">{locationMessage}</p>}
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700" htmlFor="urgency">Urgency</label>
          <select
            id="urgency"
            value={urgency}
            onChange={(e) => setUrgency(e.target.value as typeof urgency)}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
          >
            <option value="normal">Normal</option>
            <option value="urgent">Urgent</option>
            <option value="emergency">Emergency</option>
          </select>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={submitting || locating}
          className="w-full rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {submitting ? 'Submitting…' : 'Submit'}
        </button>
      </form>
    </div>
  );
}
