import { humanizeToken } from '../lib/format';

// Note: these must not use bg-slate-*/text-slate-* together. The dark-theme retheme in index.css
// force-overrides every text-slate-{500..900} utility to a light color (for readability of body
// copy on the retheme'd dark card backgrounds) but leaves bg-slate-* alone, so a slate-on-slate
// pairing here renders as illegible near-white text on a near-white pill (confirmed: "triage" and
// "intake" badges were unreadable). gray-* is untouched by that override and stays a normal
// light-chip-with-dark-text badge like every other status color below.
const COLORS: Record<string, string> = {
  completed: 'bg-emerald-100 text-emerald-800',
  cancelled: 'bg-red-100 text-red-800',
  intake: 'bg-gray-200 text-gray-800',
  triage: 'bg-gray-200 text-gray-800'
};

function colorFor(state: string) {
  if (COLORS[state]) return COLORS[state];
  if (state.endsWith('_in_progress')) return 'bg-blue-100 text-blue-800';
  if (state.endsWith('_pending') || state.endsWith('_selection')) return 'bg-amber-100 text-amber-800';
  return 'bg-gray-200 text-gray-800';
}

export function StatusBadge({ state }: { state: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${colorFor(state)}`}>
      {humanizeToken(state)}
    </span>
  );
}
