import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';

// "Talk to ROVIQ": the customer describes the problem by typing or speaking, and the assistant asks
// follow-up questions while filling in the form below (issue, urgency, a description for the
// technician). The customer still reviews the form and taps Submit; nothing is sent from here.

export type IntakeDraft = {
  issueType: string;
  urgency: 'normal' | 'urgent' | 'emergency';
  description: string;
  likelyArea: string;
  drivable: 'yes' | 'no' | 'unsure';
  safetyFlags: string[];
};

type Message = { role: 'user' | 'assistant'; content: string };
type TurnResponse = {
  reply: string;
  draft: { issueType: string; summary: string; likelyArea: string; drivable: 'yes' | 'no' | 'unsure'; urgency: 'normal' | 'urgent' | 'emergency' };
  ready: boolean;
  safetyFlags: string[];
};

const GREETING: Message = { role: 'assistant', content: 'Hi! Tell me what’s going on with your vehicle. Type, or tap the microphone and talk.' };

type Recognition = { lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null; onend: (() => void) | null; onerror: (() => void) | null };

function speechRecognition(): (new () => Recognition) | null {
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function technicianNote(summary: string, messages: Message[]) {
  const words = messages.filter((m) => m.role === 'user').map((m) => m.content.trim()).filter(Boolean).join(' / ');
  return `${summary.trim()}\n\nIn the customer’s words: ${words}`.slice(0, 2000);
}

export function IntakeChat({ onDraft }: { onDraft: (draft: IntakeDraft) => void }) {
  const [messages, setMessages] = useState<Message[]>([GREETING]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [listening, setListening] = useState(false);
  const recognition = useRef<Recognition | null>(null);
  const log = useRef<HTMLDivElement | null>(null);
  const Speech = speechRecognition();

  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' }); }, [messages, busy]);
  useEffect(() => () => recognition.current?.stop(), []);

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const content = text.trim();
    if (!content || busy) return;
    recognition.current?.stop();
    const next: Message[] = [...messages, { role: 'user', content }];
    setMessages(next);
    setText('');
    setBusy(true);
    try {
      const turn = await api.post<TurnResponse>('/api/assist/intake', { messages: next });
      const withReply: Message[] = [...next, { role: 'assistant', content: turn.reply }];
      setMessages(withReply);
      setReady(turn.ready);
      onDraft({
        issueType: turn.draft.issueType,
        urgency: turn.draft.urgency,
        description: technicianNote(turn.draft.summary, withReply),
        likelyArea: turn.draft.likelyArea,
        drivable: turn.draft.drivable,
        safetyFlags: turn.safetyFlags
      });
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 400) setUnavailable(true);
      setMessages(next);
    } finally {
      setBusy(false);
    }
  }

  function toggleMic() {
    if (!Speech) return;
    if (listening) { recognition.current?.stop(); return; }
    const r = new Speech();
    r.lang = navigator.language || 'en-US';
    r.interimResults = true;
    r.continuous = false;
    const before = text ? `${text.trim()} ` : '';
    r.onresult = (e) => setText(before + Array.from(e.results).map((res) => res[0].transcript).join(''));
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    recognition.current = r;
    setListening(true);
    r.start();
  }

  if (unavailable) {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600" role="status">
        The assistant is not available right now. Please describe the problem in the form below.
      </div>
    );
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white" aria-label="Talk to ROVIQ">
      <div className="border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-800">Talk to ROVIQ</h2>
        <p className="text-xs text-slate-500">Describe the problem in your own words. We’ll fill in the form for you.</p>
      </div>
      <div ref={log} className="max-h-72 space-y-2 overflow-y-auto px-4 py-3" aria-live="polite">
        {messages.map((m, i) => (
          <p key={i} className={`max-w-[85%] whitespace-pre-line rounded-2xl px-3 py-2 text-sm ${m.role === 'user' ? 'ml-auto bg-[var(--roviq-copper)] text-white' : 'bg-slate-100 text-slate-800'}`}>
            {m.content}
          </p>
        ))}
        {busy && <p className="w-fit rounded-2xl bg-slate-100 px-3 py-2 text-sm text-slate-500">…</p>}
      </div>
      {ready && <p className="mx-4 mb-2 rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-800" role="status">The form below is filled in. Check it, add your vehicle and location, and tap Submit.</p>}
      <form onSubmit={send} className="flex items-end gap-2 border-t border-slate-200 p-3">
        <label className="sr-only" htmlFor="intake-message">Your message</label>
        <textarea
          id="intake-message"
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
          placeholder={listening ? 'Listening…' : 'e.g. it clicks but won’t start'}
          style={{ height: 44, minHeight: 44 }}
          className="flex-1 resize-none rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
        />
        {Speech && (
          <button type="button" onClick={toggleMic} aria-pressed={listening} aria-label={listening ? 'Stop listening' : 'Speak'}
            className={`min-h-11 min-w-11 rounded-md border px-3 text-sm ${listening ? 'border-red-300 bg-red-50 text-red-700' : 'border-slate-300 bg-white text-slate-700'}`}>
            {listening ? '■' : '🎤'}
          </button>
        )}
        <button type="submit" disabled={busy || !text.trim()} className="roviq-btn-primary" style={{ minHeight: 44, padding: '0 14px' }}>Send</button>
      </form>
    </section>
  );
}
