import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { createPaymentIntent } from './payments.js';
import { consumeDiagnosticQuota } from './consumer-membership.js';
import { loadActiveRoutingPolicy } from './routing-repository.js';

/**
 * Business Plan Section 4: the on-site diagnostic visit is a real, deliverable service on its
 * own -- today it generates no revenue at all when the technician handles a job directly with no
 * further routing. Charges the standalone diagnostic coordination fee, unless the customer's
 * membership covers this visit out of its per-period included quota. Best-effort and fail-closed
 * like every other automatic charge in this codebase: no active diagnostic_fee_policies row for
 * the domain means no fee is guessed, and any failure here never blocks the finding itself from
 * being recorded.
 */
export async function chargeDiagnosticFee(
  triggeredBy: Principal,
  input: { caseId: string; customerActorId: string | null; domainId: string; findingId: string }
) {
  if (!input.customerActorId) return null;

  const already = await pool.query(
    `select 1 from payment_intents where case_id=$1 and metadata->>'kind'='diagnostic_fee' limit 1`,
    [input.caseId]
  );
  if (already.rowCount) return null;

  const covered = await consumeDiagnosticQuota(input.customerActorId);
  if (covered) return { charged: false, coveredByMembership: true };

  const policy = await loadActiveRoutingPolicy(input.domainId,'diagnostic_fee_default');
  if (!policy) return { charged: false, policyRequired: true };

  // routing_policies is a generic versioned policy store (also reused for parts_supplier_default);
  // its configuration type models the coordination-engine shape, not this domain's flat fee shape.
  const configuration = policy.configuration as unknown as { amountMinor?: number; currency?: string };
  const amountMinor = Number(configuration?.amountMinor);
  if (!Number.isFinite(amountMinor) || amountMinor <= 0) return { charged: false, policyRequired: true };
  const currency = String(configuration?.currency ?? 'USD').toUpperCase();
  const factor = currency === 'JPY' ? 1 : 100;

  const systemPrincipal: Principal = { role: 'admin' };
  const paymentIntent = await createPaymentIntent(systemPrincipal, {
    caseId: input.caseId,
    amount: amountMinor / factor,
    currency,
    description: 'Diagnostic coordination fee',
    metadata: { kind: 'diagnostic_fee', policyId: policy.id, findingId: input.findingId, triggeredByRole: triggeredBy.role },
    skipQuoteApproval: true
  });

  return { charged: true, coveredByMembership: false, paymentIntent };
}
