import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';

// The AI's first read of a new case, made automatically from what the customer said. A suggestion
// for Ops only: it never routes or dispatches, and the technician's finding is the diagnosis.

type Assessment = {
  id: string;
  symptom_summary: string | null;
  suggested_capabilities: string[] | null;
  suggested_drivability: 'unknown' | 'drivable' | 'limited' | 'non_drivable' | null;
  safety_flags: Array<{ code?: string; severity?: string }> | null;
  confidence: number | string | null;
  safety_override: boolean | null;
  created_at: string;
};

const DRIVABILITY: Record<string, string> = { drivable: 'Drivable', limited: 'Drive with care', non_drivable: 'Not drivable', unknown: 'Unknown' };
const label = (s: string) => s.replace(/_/g, ' ');

export function AiFirstRead() {
  const { id } = useParams<{ id: string }>();
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [state, setState] = useState<'loading' | 'waiting' | 'ready' | 'error'>('loading');

  useEffect(() => {
    if (!id) return;
    let active = true;
    let tries = 0;
    let timer: number | undefined;
    const load = async () => {
      try {
        const r = await api.get<{ assessments: Assessment[] }>(`/api/maintenance/cases/${id}/triage`);
        if (!active) return;
        const latest = r.assessments[0] ?? null;
        setAssessment(latest);
        setState(latest ? 'ready' : 'waiting');
        // A new case's read arrives a few seconds after it is created.
        if (!latest && ++tries < 12) timer = window.setTimeout(load, 10000);
      } catch {
        if (active) setState('error');
      }
    };
    void load();
    return () => { active = false; window.clearTimeout(timer); };
  }, [id]);

  if (state === 'loading' || state === 'error') return null;
  if (!assessment) {
    return <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">AI first read: not available for this case yet.</section>;
  }
  const confidence = Math.round(Number(assessment.confidence ?? 0) * 100);
  const flags = (assessment.safety_flags ?? []).map((f) => f.code).filter((c): c is string => Boolean(c));
  const drivability = assessment.suggested_drivability ?? 'unknown';
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4" aria-labelledby="ai-first-read">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="ai-first-read" className="text-sm font-semibold text-slate-800">AI first read</h2>
        <span className="text-xs text-slate-400">Suggestion only · the technician confirms the diagnosis</span>
      </div>
      {flags.length > 0 && (
        <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm font-medium text-red-800" role="alert">
          Safety: {flags.map(label).join(', ')}. Treat as not drivable.
        </p>
      )}
      {assessment.symptom_summary && <p className="mt-3 text-sm text-slate-700">{assessment.symptom_summary}</p>}
      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
        <div className="rounded-md bg-slate-50 px-3 py-2"><dt className="text-xs text-slate-500">Drivable</dt><dd className={`font-medium ${drivability === 'non_drivable' ? 'text-red-700' : 'text-slate-800'}`}>{DRIVABILITY[drivability] ?? label(drivability)}</dd></div>
        <div className="rounded-md bg-slate-50 px-3 py-2"><dt className="text-xs text-slate-500">Send first</dt><dd className="font-medium capitalize text-slate-800">{(assessment.suggested_capabilities ?? []).map(label).join(', ') || '—'}</dd></div>
        <div className="rounded-md bg-slate-50 px-3 py-2"><dt className="text-xs text-slate-500">Confidence</dt><dd className="font-medium text-slate-800">{confidence}%</dd></div>
      </dl>
    </section>
  );
}
