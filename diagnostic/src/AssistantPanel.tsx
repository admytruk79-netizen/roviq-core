import { useRef, useState, type FormEvent } from 'react';
import { claimError, claimOpenJob, here } from './OpenJobsPanel';

// "Ask ROVIQ" for diagnostic technicians: plain-language questions about their own jobs
// ("show me the nearest cases", "take the closest one"). Answers come from the technician's own
// queue. Accepting or declining is prepared by the assistant and done only when they tap Confirm.

type Job = { ref: number; offerId?: string; jobId?: string; issue: string; urgency: string; status: 'offered' | 'accepted' | 'open'; distanceKm: number | null; jobRank?: string; vehicle?: string | null };
type Proposal =
  | { action: 'respond_offer'; offerId: string; outcome: 'accepted' | 'declined'; label: string }
  | { action: 'claim_open_job'; jobId: string; label: string };
type Turn = { reply: string; jobs: Job[]; proposal?: Proposal };
type Entry = { who: 'me' | 'roviq'; text: string; jobs?: Job[]; proposal?: Proposal };

const BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');
const TOKEN = 'roviq_diagnostic_token';
const SUGGESTIONS = ['Nearest cases', 'Open jobs near me', 'What’s urgent?', 'Take the closest one'];
const idOf = (x: { offerId?: string; jobId?: string }) => x.offerId ?? x.jobId ?? '';

export function AssistantPanel({ onOpen, onRespond, onClaimed }: { onOpen: (offerId: string) => void; onRespond: (offerId: string, outcome: 'accepted' | 'declined') => Promise<void>; onClaimed: (caseId: string) => void }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string[]>([]);
  const lastJobs = useRef<string[]>([]);

  async function ask(message: string, event?: FormEvent) {
    event?.preventDefault();
    const content = message.trim();
    if (!content || busy) return;
    setEntries((e) => [...e, { who: 'me', text: content }]);
    setText('');
    setBusy(true);
    try {
      const location = await here();
      const res = await fetch(`${BASE}/api/assist/work`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${localStorage.getItem(TOKEN) ?? ''}` },
        body: JSON.stringify({ message: content, location, lastJobs: lastJobs.current })
      });
      if (!res.ok) throw new Error(String(res.status));
      const turn = await res.json() as Turn;
      if (turn.jobs.length > 1) lastJobs.current = turn.jobs.map(idOf);
      setEntries((e) => [...e, { who: 'roviq', text: turn.reply, jobs: turn.jobs, proposal: turn.proposal }]);
    } catch {
      setEntries((e) => [...e, { who: 'roviq', text: 'I couldn’t reach your jobs just now. Try again in a moment.' }]);
    } finally {
      setBusy(false);
    }
  }

  async function confirm(p: Proposal) {
    setBusy(true);
    try {
      if (p.action === 'claim_open_job') {
        const caseId = await claimOpenJob(p.jobId);
        setDone((d) => [...d, p.jobId]);
        onClaimed(caseId);
      } else {
        await onRespond(p.offerId, p.outcome);
        setDone((d) => [...d, p.offerId]);
      }
    } catch (err) {
      setEntries((e) => [...e, { who: 'roviq', text: p.action === 'claim_open_job' ? claimError(err) : 'That didn’t go through. Try again.' }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel assistant" aria-label="Ask ROVIQ">
      <div className="assistant-head"><span className="eyebrow">Ask ROVIQ</span><span className="assistant-hint">Your jobs, in plain words. You confirm every action.</span></div>
      <div className="assistant-log" aria-live="polite">
        {entries.map((e, i) => (
          <div key={i} className={e.who === 'me' ? 'assistant-me' : 'assistant-roviq'}>
            <p>{e.text}</p>
            {e.jobs && e.jobs.length > 0 && !e.proposal && (
              <ul className="assistant-jobs">
                {e.jobs.map((j) => (
                  <li key={idOf(j)}>
                    <span><b>{j.ref}. {j.issue}</b>{j.jobRank ? ` · ${j.jobRank}` : ''}{j.vehicle ? ` · ${j.vehicle}` : ''}{j.urgency !== 'normal' ? ` · ${j.urgency}` : ''}{j.distanceKm != null ? ` · ${j.distanceKm} km` : ''}{j.status === 'offered' ? ' · new' : ''}</span>
                    {j.offerId && <button type="button" className="secondary" onClick={() => onOpen(j.offerId!)}>Open</button>}
                  </li>
                ))}
              </ul>
            )}
            {e.proposal && (
              done.includes(idOf(e.proposal))
                ? <p className="assistant-done" role="status">Done.</p>
                : <button type="button" className={e.proposal.action === 'claim_open_job' || e.proposal.outcome === 'accepted' ? 'primary' : 'secondary'} disabled={busy} onClick={() => void confirm(e.proposal!)}>Confirm: {e.proposal.label}</button>
            )}
          </div>
        ))}
        {busy && <p className="assistant-roviq">…</p>}
      </div>
      {entries.length === 0 && (
        <div className="assistant-suggestions">
          {SUGGESTIONS.map((s) => <button key={s} type="button" className="secondary" disabled={busy} onClick={() => void ask(s)}>{s}</button>)}
        </div>
      )}
      <form className="assistant-input" onSubmit={(e) => void ask(text, e)}>
        <label className="sr-only" htmlFor="assistant-message">Ask about your jobs</label>
        <input id="assistant-message" value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. show me the nearest cases" autoComplete="off" />
        <button type="submit" className="primary" disabled={busy || !text.trim()}>Ask</button>
      </form>
    </section>
  );
}
