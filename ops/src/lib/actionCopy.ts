import { humanizeToken } from './format';
import type { CaseTransition } from './types';

export type ActionCopy = { label: string; description: string; tone?: 'primary' | 'secondary' };

// Single source of truth for how a case-state transition reads to ops staff. This used to be
// duplicated (with different wording) between CaseActionView's quick-action bar and CaseDetail's
// "Next action" panel -- both render buttons for the exact same transitions on the exact same
// page, so a wording mismatch (e.g. "Continue diagnostics" vs "Diagnosis underway" for the same
// toState) was visible in a single glance, not just across screens.
export const ACTION_COPY: Record<string, ActionCopy> = {
  triage: { label: 'Begin triage', description: 'Review the request and determine the next service path.' },
  diagnostic_pending: { label: 'Request diagnosis', description: 'Move this case into the diagnostic workflow.' },
  diagnostic_in_progress: { label: 'Continue diagnostics', description: 'Confirm that diagnostic work has started.' },
  provider_selection: { label: 'Find repair provider', description: 'Evaluate eligible repair capacity for this case.' },
  provider_pending: { label: 'Send to selected provider', description: 'Move the case into provider acceptance.' },
  repair_in_progress: { label: 'Begin repair', description: 'Confirm that the provider has started the repair.' },
  tow_pending: { label: 'Arrange transport', description: 'Prepare a tow or valet handoff.' },
  tow_in_progress: { label: 'Track transport', description: 'Confirm the vehicle is moving to its destination.' },
  parts_pending: { label: 'Send to parts fulfilment', description: 'Hand the repair off to a parts supplier.' },
  payment_pending: { label: 'Request payment', description: 'Move the case to payment collection.' },
  completed: { label: 'Complete case', description: 'Mark the operational work complete.' },
  cancelled: { label: 'Cancel case', description: 'Stop this service case. This cannot be undone.', tone: 'secondary' }
};

export function actionCopy(state: string): ActionCopy {
  return ACTION_COPY[state] ?? { label: humanizeToken(state), description: `Continue this case to ${humanizeToken(state).toLowerCase()}.` };
}

export function actionLabel(state: string): string {
  return actionCopy(state).label;
}

// `provider_selection -> provider_pending` is a real, admin-allowed row in case_transition_rules,
// so the generic transitions endpoint offers it like any other next step. But firing it through
// the plain transition endpoint (as this button does) skips every check select-provider performs
// (actor eligibility against the routing decision, capacity, recording selected_actor_id) -- it
// can leave a case sitting in provider_pending with no provider ever offered it. The safe way to
// make this move is the "Find repair provider" -> evaluate -> select flow in case tools & details,
// so the raw one-click transition is hidden here rather than offered as a shortcut around it.
const UNSAFE_RAW_TRANSITIONS: Record<string, string[]> = {
  provider_selection: ['provider_pending']
};

export function safeTransitions(fromState: string, transitions: CaseTransition[]): CaseTransition[] {
  const blocked = UNSAFE_RAW_TRANSITIONS[fromState];
  if (!blocked) return transitions;
  return transitions.filter((t) => !blocked.includes(t.toState));
}

// `cancelled` is appended to every case's transition list (see GET .../transitions) so it is
// always reachable, but it must never be *the* default action -- a destructive, terminal, one-way
// transition should never occupy the same "big primary button" slot as an ordinary forward step,
// especially once safeTransitions above can leave it as the only entry left in the list. Demote it
// to secondary unconditionally so the primary slot is only ever a real forward-moving action.
export function splitTransitions(transitions: CaseTransition[]): { primary: CaseTransition | null; secondary: CaseTransition[] } {
  const forward = transitions.filter((t) => t.toState !== 'cancelled');
  const cancel = transitions.find((t) => t.toState === 'cancelled') ?? null;
  return {
    primary: forward[0] ?? null,
    secondary: cancel ? [...forward.slice(1), cancel] : forward.slice(1)
  };
}
