import { humanizeToken } from '../lib/format';

const COLORS: Record<string, string> = {
  completed: 'bg-emerald-100 text-emerald-800',
  cancelled: 'bg-red-100 text-red-800',
  intake: 'bg-slate-100 text-slate-700',
  triage: 'bg-slate-100 text-slate-700'
};

function colorFor(state: string) {
  if (COLORS[state]) return COLORS[state];
  if (state.endsWith('_in_progress')) return 'bg-blue-100 text-blue-800';
  if (state.endsWith('_pending') || state.endsWith('_selection')) return 'bg-amber-100 text-amber-800';
  return 'bg-slate-100 text-slate-700';
}

export function StatusBadge({ state }: { state: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${colorFor(state)}`}>
      {humanizeToken(state)}
    </span>
  );
}
