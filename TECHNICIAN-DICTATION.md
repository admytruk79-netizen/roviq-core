# Technician dictation and finding drafts

Implemented locally in the partial source snapshot, using the existing Cloudflare Workers AI binding. No OpenAI key or new AI provider is required by this implementation. Nothing has been pushed or deployed.

Accepted assignment → speak or type observations → edit transcription → prepare structured draft → review and edit → use reviewed draft in the existing finding form → explicitly choose drivability/disposition → save through the existing Core findings endpoint.

The new `/api/assist/finding` endpoint checks the bearer identity through Core, requires diagnostic/tow role with an actor, and verifies the demand is in the actor's accepted diagnostic queue before inference. This is a draft endpoint: it performs no finding writes or handoffs. Authorization is checked again by the existing finding submission flow.

Original observations accompany the reviewed summary. DTC codes are extracted from the original text, not model-generated fields. Speech recognition can still mishear codes, so the UI asks the technician to verify them. AI does not select drivability, disposition, pricing or providers. Its summary is a suggestion that can contain errors; review is essential. Malformed/unavailable AI falls back to the original observations. Manual entry remains available when microphone or cloud services fail.

Browser speech recognition uses the supported browser API and may involve a remote speech service; the panel discloses this. No custom audio recording/transcription service, physical scanner adapter, OBD pairing, or automatic diagnostic decision has been added.

Verification: six dependency-free behavior tests passed, covering AI draft/original preservation, malformed/missing AI fallback, input limits, accepted-assignment gating, role checks, read-only behavior and Core failure. Worker JavaScript syntax checks passed. Live AI, browser microphone permissions, React/TypeScript compilation and the full existing CI have not been verified because this environment cannot clone/install through its proxy.

Run `node tests/finding-assist.node.test.mjs` or `node tests/run-simulations.mjs` with Node 24. The AI and Core responses are mocked; the finding-assist logic is the actual implementation.

Before deployment: run full Worker and diagnostic app builds; add authenticated endpoint/browser tests; verify role/tenant denial and revoked sessions; test mobile speech support, denied mic permissions, transcript corrections, switching cases and slow/offline responses; verify inference timeout/rate limiting and approved data retention. Then test the existing save/handoff workflow with real independent technician and partner accounts.
