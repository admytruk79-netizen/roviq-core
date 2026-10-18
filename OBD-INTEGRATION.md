# OBD integration

Hardware candidate: OBDLink MX+ using classic Bluetooth RFCOMM on Android. Vendor compatibility has been researched; no physical scanner/vehicle validation has occurred.

## Implemented path

Customer consents and enrolls a paired scanner against a case vehicle. An assigned diagnostic actor or selected/current shop can discover only permitted enrollments. The Android bridge exposes list, scan and cancel to exact customer and diagnostic HTTPS origins, only in the main frame. It handles nearby-device permission and physical-vehicle confirmation, cancels on navigation/backgrounding, and never exposes arbitrary scanner commands or bearer tokens.

The transport configures an ELM headerless profile, queries supported PIDs, and reads stored DTCs and available MIL/RPM/coolant/speed observations. Strict parsing rejects malformed, incomplete, no-data and unsupported multi-ECU layouts. Nothing clears codes or controls the ECU. No-code output does not establish vehicle health; generic odometer support is not assumed.

After user review, authenticated ingestion validates vehicle/case/source/enrollment binding and active consent. Retries reuse the original scan ID and observed time. An event-scoped analysis request references the stored event rather than accepting client-supplied model evidence. Migration 088 creates one job and fixed assessment identity per event. Atomic claims, expiring leases and lease-token checks prevent a replaced worker publishing its result. Job result and proposed assessment persist together. Reviewed assessments are protected from retry updates.

Cloudflare Workers AI produces advisory hypotheses with exact recorded code/measurement references. Inference has a 15-second deadline. Missing, malformed, stalled or unavailable inference records explicit fallback status, preserves observations and retries with backoff up to five claimed inference attempts. Scheduled processing runs alongside existing operations; the immediate request can also launch a background claim. Consent/case validity is checked before and after inference. These checks do not establish serializable protection against every concurrent revocation transaction.

Customer and diagnostic panels show original readings, confirmation, queued status and AI/fallback review text. No assessment automatically authorizes work or determines drivability. A scan pending upload/analysis is stored in IndexedDB, limited to ten entries and seven days since last save. Local entries contain raw scanner evidence and binding IDs, no bearer token or VIN; they are not encrypted. Account separation is a UI/storage namespace, not a defense against malicious same-origin code. Pending scans require renewed vehicle confirmation after restoration.

## Release verification

`node tests/run-simulations.mjs` passes 70 scenarios across coordination, connection access, sign-in, dictation, parser, native message client, ingestion handlers, analysis and outbox behavior. Most external boundaries are mocked. `node tests/obd-queue-postgres.mjs` adds real SQL regression coverage for a migrated local acceptance database and refuses remote database hosts; CI runs it before the full Core E2E suite.

Full Core, Worker, frontend and Android builds must pass CI. Physical MX+ fixtures, Android permission and WebView behavior, a legitimate registered source/enrollment, configured live cloud inference, cross-company access and outage recovery still require acceptance. The Customer and Actor native flavors now open their respective product origins. Actor offers a main-frame diagnostic workspace with a return to its role chooser, enabling the native bridge without allowing subframes to invoke it. Both Android flavors still require physical scanner acceptance.

## Sources

- https://www.obdlink.com/products/obdlink-mxp/
- https://www.obdlink.com/faq/
- https://www.obdlink.com/mxp/apps/
- https://www.scantool.net/scantool/downloads/678/obdlink_frpm_e.pdf
- https://developer.android.com/develop/connectivity/bluetooth/connect-bluetooth-devices
- https://developer.android.com/develop/connectivity/bluetooth/bt-permissions
