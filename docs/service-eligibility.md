# Business service credential handshake

Ops → Eligibility manages a business's authorization for repair, diagnostic, tow, valet, parts and mobility services. One business can hold several authorizations. Expiry of towing makes towing unavailable without removing staff logins, diagnostic/repair permissions, history or existing jobs. The current eligible service count is computed from current credentials; it is not a count of staff accounts or workspaces.

An administrator reviews the credential bundle outside the app, records its evidence reference, validity period, earliest expiry across all required credentials, decision and reason. Only verified, currently valid authorizations qualify. Pending, suspended, revoked, future-dated, missing or expired authorization blocks new work. Every review records before/after data and the administrator identity in the audit log. This is an Ops attestation, not automated license-issuer validation or a substitute for jurisdiction/person-specific certification checks.

Newly onboarded businesses automatically enroll in these checks. Migration 090 enrolls organizations previously created by the new business-onboarding flow, without inventing authorizations. Older organizations remain explicitly marked **Legacy: enrollment required** until Ops enables checks after reviewing their records. There is no API to turn checks back off. This staged rollout is a material limit: legacy organizations are not yet protected by the new credential registry.

The authoritative gate runs in PostgreSQL before offer creation/acceptance (including open-job claims), selected-shop changes, transport assignment/acceptance, parts supplier assignment/reservation/ordering, mobility assignment/activation and service network handoffs. Offers store their required service so a later case-state change does not silently reinterpret a diagnostic offer as repair. Database wall-clock time prevents a long transaction from extending validity. Assignment locks serialize against organization enrollment and credential review. A rejected write returns HTTP 409 `service_credential_ineligible` and rolls back the transaction.

The gate adds credential checks to existing capability, tenant-access, geography, capacity and customer-authorization checks. It does not grant operator capabilities, change identity roles, replace those existing checks or claim that every assignment path independently enforces all of them. The generic Core engine has other case domains; this registry governs the automotive service assignment records listed above, not every possible future Core task.

Ops sees existing work with an ineligible provider in the live credential-review list. It does not automatically cancel work or strand a customer vehicle. Accepted transport may continue through its existing workflow while Ops reviews safety/reassignment. Parts reservation/ordering and mobility activation are rechecked. Lists refresh every 30 seconds; authoritative enforcement does not depend on this refresh or a cron sweep. Renewing a verified authorization restores eligibility immediately, subject to the other existing readiness checks. No external notifications are sent by this feature.

Admin APIs:

- `GET /api/admin/service-eligibility`: organizations/enrollment, current authorization records and work requiring review.
- `POST /api/admin/service-eligibility/:organizationId/enroll`: enable enforcement, idempotently; credentials are not fabricated.
- `PUT /api/admin/service-eligibility/:organizationId/:service`: `state`, ISO `validFrom`, optional `expiresAt` (required for verified), `evidenceReference`, `reason`.
- `GET /api/me/service-eligibility`: the signed-in actor's own organization and service states, without proof references or verifier details.

All current row limits are explicit in the source (500 organizations/review items, 1,000 authorizations); pagination is future work. A proof reference is text, not an uploaded or automatically verified document.
