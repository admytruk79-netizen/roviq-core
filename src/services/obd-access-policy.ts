type Principal = { role: string; actorId?: string };
type ScanCase = Record<string, unknown>;
type Enrollment = { enrollment_status: string; consent_status: string; customer_actor_id?: string | null; retention_until?: string | null; scopes?: unknown };

function deny(message: string, statusCode = 403): never { throw Object.assign(new Error(message), { statusCode }); }

// Case access must already have been validated through loadCaseForPrincipal.
export function assertTechnicianScanCase(principal: Principal, vehicleId: string, record: ScanCase | null) {
  if (!['diagnostic', 'partner'].includes(principal.role) || !principal.actorId) deny('forbidden');
  if (!record) deny('case_not_found', 404);
  if (['completed', 'cancelled'].includes(String(record.state ?? ''))) deny('case_closed', 409);
  if (record.vehicle_id !== vehicleId) deny('case_vehicle_mismatch', 409);
  if (record.current_owner_actor_id !== principal.actorId && record.selected_actor_id !== principal.actorId) deny('scan_assignment_required');
}

export function assertScanConsent(record: ScanCase, enrollment: Enrollment, now = Date.now()) {
  if (!record.customer_actor_id || enrollment.customer_actor_id !== record.customer_actor_id) deny('scan_consent_customer_mismatch');
  if (enrollment.enrollment_status !== 'active' || enrollment.consent_status !== 'active') deny('scan_consent_not_active');
  if (enrollment.retention_until) {
    const expiry = Date.parse(enrollment.retention_until);
    if (!Number.isFinite(expiry) || expiry <= now) deny('scan_consent_expired');
  }
  if (!Array.isArray(enrollment.scopes) || !enrollment.scopes.includes('vehicle_health')) deny('vehicle_health_scope_required');
}
