import { useEffect, useRef, useState } from 'react';

type Recognition = { lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null; onerror: (() => void) | null };
type Draft = { assistant: 'ai' | 'fallback'; summary: string; originalNotes: string; dtcCodes: string[]; missingInformation: string[] };
const BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

export function FindingDraftPanel({ demandId, onUse }: { demandId: string; onUse: (summary: string) => void }) {
  const [notes, setNotes] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState('');
  const recognition = useRef<Recognition | null>(null);
  const mounted = useRef(true);
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  const Speech = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; recognition.current?.stop(); }; }, []);

  function speak() {
    if (listening) { recognition.current?.stop(); return; }
    if (!Speech) return;
    const r = new Speech();
    r.lang = navigator.language || 'en-US'; r.interimResults = true; r.continuous = false;
    const prefix = notes.trim() ? `${notes.trim()} ` : '';
    r.onresult = event => { if (mounted.current) { setNotes((prefix + Array.from(event.results).map(result => result[0].transcript).join(' ')).slice(0, 5000)); setDraft(null); } };
    r.onend = () => { if (mounted.current) setListening(false); };
    r.onerror = () => { if (mounted.current) { setListening(false); setError('Microphone unavailable. You can type your observations.'); } };
    recognition.current = r; setError('');
    try { r.start(); setListening(true); } catch { setError('Microphone unavailable. You can type your observations.'); }
  }
  async function prepare() {
    recognition.current?.stop(); setListening(false); setBusy(true); setError(''); setDraft(null);
    try {
      const res = await fetch(`${BASE}/api/assist/finding`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${localStorage.getItem('roviq_diagnostic_token') ?? ''}` }, body: JSON.stringify({ demandId, notes }), signal: AbortSignal.timeout(35000) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'draft_unavailable');
      if (mounted.current) setDraft(body);
    } catch { if (mounted.current) setError('Could not prepare a draft. Your notes are still here; you can use them directly.'); }
    finally { if (mounted.current) setBusy(false); }
  }
  function useDraft() {
    if (!draft) return;
    const codes = draft.dtcCodes.length ? `\nReported scan codes: ${draft.dtcCodes.join(', ')}` : '';
    onUse(`${draft.summary}${codes}\n\nOriginal technician observations:\n${draft.originalNotes}`);
  }
  return <section className="panel form" aria-label="Draft diagnostic observations">
    <h3>Speak or type your findings</h3>
    <p className="hint">Record symptoms, tests and scan readings. Check speech transcription carefully, especially fault codes. Your browser may use a remote speech service.</p>
    <label>Observations<textarea value={notes} maxLength={5000} disabled={busy} onChange={e => { setNotes(e.target.value); setDraft(null); }} placeholder="What did you observe or measure?" /></label>
    <div className="actions">
      {Speech && <button type="button" className="secondary" disabled={busy} aria-pressed={listening} onClick={speak}>{listening ? 'Stop listening' : 'Dictate observations'}</button>}
      <button type="button" className="secondary" disabled={busy || listening || notes.trim().length < 3} onClick={() => void prepare()}>{busy ? 'Preparing…' : 'Prepare draft'}</button>
      <button type="button" className="secondary" disabled={busy || listening || notes.trim().length < 3} onClick={() => onUse(notes)}>Use original notes</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {draft && <div aria-live="polite">
      <p className="hint">{draft.assistant === 'ai' ? 'AI draft — verify every statement.' : 'AI unavailable — original notes preserved.'} No finding has been saved.</p>
      <label>Review the draft<textarea value={draft.summary} onChange={e => setDraft({ ...draft, summary: e.target.value })} /></label>
      {draft.dtcCodes.length > 0 && <p>Reported codes: {draft.dtcCodes.join(', ')}</p>}
      {draft.missingInformation.length > 0 && <ul>{draft.missingInformation.map((item, index) => <li key={index}>{item}</li>)}</ul>}
      <button type="button" className="secondary" disabled={!draft.summary.trim()} onClick={useDraft}>Use reviewed draft</button>
      <p className="hint">Choose vehicle condition and next step below, then save the finding.</p>
    </div>}
  </section>;
}
