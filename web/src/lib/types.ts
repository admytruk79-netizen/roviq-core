export type Principal = { role: string; actorId: string | null };

export type ServiceCase = {
  id: string;
  state: string;
  priority: string;
  drivability: string;
  case_type: string;
  current_owner_role: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
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
