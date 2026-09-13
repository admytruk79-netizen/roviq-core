# ROVIQ Connected Diagnostics / Reader Architecture

Status: architecture-ready, runtime integration deferred until Production Hardening (POA Step 11) is complete.

## Purpose

ROVIQ Connected Diagnostics adds vehicle-health signals as an input channel to ROVIQ Core without making physical hardware a prerequisite for the Maintenance pilot. The system supports three acquisition paths behind one canonical diagnostic-ingestion contract:

1. OEM / telematics integrations where authorized.
2. Supported vehicle-platform APIs such as selected Android Automotive / car-hardware data where available.
3. A low-cost ROVIQ OBD-II reader for vehicles that do not expose sufficient connected data.

No acquisition source is allowed to become an independent workflow authority. Fastify Core remains authoritative for triage, policy, serviceability, routing, case state and audit. Neon PostgreSQL remains the canonical business-state store.

## Reference flow

Vehicle ECU / OEM source
→ acquisition adapter
→ device or provider authentication
→ diagnostic ingestion gateway
→ source validation + replay protection
→ canonical vehicle diagnostic event
→ vehicle-health projection
→ triage / urgency interpretation
→ Service Case creation or attachment
→ serviceability / provider / tow / mobility coordination
→ resolution and outcome history

## ROVIQ Reader hardware boundary

The first Reader should be intentionally simple and inexpensive:

- OBD-II connector.
- Bluetooth Low Energy transport to the ROVIQ mobile app.
- Unique device identity and revocable provisioning credential.
- No independent cellular modem required for the initial consumer version.
- No business rules, routing logic or diagnostic conclusions stored on-device.
- Optional local buffering only for bounded delivery retry when the phone is temporarily offline.

The phone provides account identity, consent UI, network transport, device enrollment, firmware metadata and user-facing diagnostic presentation.

## Data classes

Depending on vehicle support and user consent, the ingestion layer may receive:

- VIN or another vehicle identifier where available.
- Standard diagnostic trouble codes (DTCs).
- MIL / warning state.
- Freeze-frame data where exposed.
- Selected OBD parameter IDs and sensor readings.
- Battery / voltage data where available.
- Mileage / usage data where available and authorized.
- Device connectivity, firmware and health metadata.

The canonical diagnostic event preserves the original source signal while standardizing the surrounding envelope: source, vehicle, code namespace, timestamp, units, status, confidence/source quality, device/provider identity and consent basis.

ROVIQ must not rewrite an authoritative OBD trouble code. For example, P0302 remains P0302. Normalization applies to the event envelope and interpretation fields, not to the source code itself.

## Canonical event contract

A diagnostic event should include at minimum:

- event_id
- source_type: roviq_reader | oem_telematics | vehicle_platform | manual_scan
- source_provider
- source_event_id / replay key
- vehicle_id
- observed_at
- received_at
- code_namespace
- code
- status: active | pending | historical | cleared | unknown
- warning_indicator
- freeze_frame / sensor payload where permitted
- original_payload reference or bounded raw payload
- consent_version / consent_scope
- device_id or integration_connection_id
- ingestion_quality / confidence metadata

Provider-specific fields stay inside source metadata. Core business logic consumes the canonical contract.

## Security

Reader enrollment must be explicit and account-bound. Required controls:

- unique device ID;
- per-device provisioning secret or public/private key identity;
- revocable device authorization;
- short-lived app/API tokens;
- TLS for phone-to-Core communication;
- replay protection using source event IDs plus provider/device namespace;
- bounded payload sizes;
- schema validation before persistence;
- audit trail for enrollment, revocation, consent changes and diagnostic ingestion;
- no secrets embedded in public mobile bundles beyond public configuration;
- fail closed when vehicle ownership/authorization or consent cannot be established.

## Consent and disclosure

The mobile enrollment flow must state what the device can collect and why. Consent must be versioned and stored. Users must be able to see whether continuous monitoring is enabled and revoke a Reader.

Suggested collection categories include vehicle identification, trouble codes, malfunction/warning state, selected operating/sensor data, mileage/usage where supported and device connectivity metadata.

ROVIQ diagnostic output is informational and must not claim to replace inspection by a qualified technician. Safety-critical uncertainty should escalate to qualified diagnosis or transport rather than generate unsupported repair conclusions.

## Data sharing

Default policy: diagnostic data is retained within the user's ROVIQ account and Core. Provider sharing occurs only when needed for a requested service, explicitly authorized by the user, or required for an active coordinated case under the governing privacy terms.

The application should expose practical controls such as:

- ROVIQ only;
- share with the selected service provider for this case;
- continuous vehicle monitoring on/off.

## Subscription boundary

The Reader is not the primary product value. It is an acquisition node for the ROVIQ coordination service.

Potential subscription capabilities:

- connected vehicle-health history;
- meaningful fault alerts;
- urgency / drivability triage;
- maintenance reminders;
- service-case creation from diagnostic signals;
- provider scheduling / routing;
- towing / mobility coordination;
- resolution tracking.

Hardware pricing and subscription packaging remain business-plan decisions and are not hard-coded into Core.

## Core integration model

The Reader must enter Core through a dedicated ingestion boundary rather than writing directly to service-case tables.

Proposed runtime modules after the pilot gate:

- `vehicle-diagnostic-ingestion` — authenticate source, validate envelope, replay protection.
- `vehicle-diagnostic-normalization` — translate source payloads into canonical diagnostic events.
- `vehicle-health-projection` — current vehicle-health state derived from canonical events.
- `diagnostic-triage` — rules/assistance that determines informational, service-needed, urgent, or non-drivable recommendations.
- `diagnostic-case-linker` — attaches signals to an existing Service Case or proposes creation of a new one.

These modules must use the existing Core authorization, audit, idempotency and transaction conventions.

## Rollout sequence

Phase A — current PR #30 / POA Step 11

- Architecture and contracts only.
- Do not introduce Reader dependencies into production-critical Maintenance paths.
- Complete existing Core hardening and exact-head CI verification.

Phase B — controlled Maintenance pilot

- Validate end-to-end intake, triage, provider/tow coordination, financial closure and operational recovery without requiring Reader hardware.

Phase C — connected-data integration

- Add canonical diagnostic ingestion tables/API.
- Add one non-hardware data source or simulated contract harness.
- Validate replay, consent, tenant/vehicle ownership and case linkage.

Phase D — Reader prototype

- BLE OBD-II prototype.
- Device enrollment/revocation.
- Android integration.
- Controlled internal fleet/test vehicles.

Phase E — consumer Reader

- Hardware sourcing/certification as required.
- Firmware/update policy.
- Subscription packaging.
- Privacy disclosure and support operations.

## Production gate

The Reader must not be used as a production-routing authority merely because a code exists. Diagnostic evidence informs triage and case creation; normal ROVIQ serviceability, provider-readiness, capacity, customer constraints, transport, parts and policy gates still apply before service selection or confirmation.
