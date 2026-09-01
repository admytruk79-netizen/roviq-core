export type Principal = { role: string; actorId: string | null };

export type ServiceCase = {
  id: string;
  demand_id?: string | null;
  state: string;
  priority: string;
  drivability: string;
  case_type: string;
  current_owner_role: string | null;
  customer_actor_id?: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
  attributes?: { description?: string; demandType?: string } & Record<string, unknown>;
};

export type ActorSummary = {
  id: string;
  actor_type: string;
  status: string;
  domain: string | null;
  attributes: Record<string, unknown>;
  created_at: string;
};

export type CustomerSnapshot = {
  customer_status: string;
  customer_message: string | null;
  next_action: string | null;
  eta_at: string | null;
  updated_at: string;
} | null;

export type TimelineEvent = {
  id: string;
  event_type: string;
  actor_id: string | null;
  occurred_at: string;
  payload: Record<string, unknown>;
};

export type CaseApproval = {
  id: string;
  case_id: string;
  service_plan_id: string;
  revision: number;
  approval_type: string;
  state: string;
  amount_minor: number | null;
  currency: string | null;
  requested_from_actor_id: string | null;
  created_at: string;
  decided_at: string | null;
};

export type ServicePlanTask = {
  id: string;
  task_type: string;
  title: string;
  instructions: string | null;
  estimated_amount_minor: number | null;
  currency: string;
};

export type ServicePlanResponse = {
  plan: { id: string; status: string; customer_summary: string | null; estimated_total_minor: number | null; currency: string; current_revision: number };
  revisions: unknown[];
  tasks: ServicePlanTask[];
  commitments: unknown[];
  approvals: CaseApproval[];
  quotes: unknown[];
};

export type PaymentIntent = {
  id: string;
  case_id: string;
  amount: string;
  currency: string;
  state: string;
  description: string | null;
  created_at: string;
  authorized_at: string | null;
  captured_at: string | null;
};

export type CaseException = {
  id: string;
  case_id: string;
  code: string;
  summary: string;
  severity: 'info' | 'warning' | 'critical';
  state: string;
  case_state: string;
  priority: string;
  created_at: string;
};

export type CaseTransition = { toState: string; terminal: boolean };

export const CASE_STATES = [
  'intake',
  'triage',
  'diagnostic_pending',
  'diagnostic_in_progress',
  'tow_pending',
  'tow_in_progress',
  'provider_selection',
  'provider_pending',
  'repair_in_progress',
  'parts_pending',
  'payment_pending',
  'completed',
  'cancelled'
] as const;
