# Operator qualification reviews

Ops → Qualifications manages actor-specific evidence consumed by the opt-in MACRE case qualification gate. Business-wide service authorizations remain separate in Ops → Eligibility.

An authenticated, active administrator identity is required to write reviews. Shared development admin headers cannot record reviews. The server records the reviewer identity, time, source reference, reason, version, and full before/after audit event in the same transaction. An audit failure rolls back the evidence change. Operators cannot self-verify or read the private registry.

Create a separate record for each evidence document using the exact requirement key, kind and scope registered on a case. Review it as unverified, verified, expired or revoked. Verified evidence requires a nonempty source and either a future expiry or an explicit no-expiry decision. Verification is a human decision after checking the evidence; this does not connect to licensing authorities or issuer APIs. No evidence documents are uploaded by this form.

Existing records keep their subject (actor, requirement key, kind and scope). Reviews can update status, source, expiry and reason. A UUID identifies a record and a version prevents concurrent/stale edits from overwriting a newer decision. Reload after an uncertain request outcome before retrying. Records and review history are retained; there is no delete endpoint. The UI shows the latest 100 audit reviews per actor.

Revocation affects the chosen record. Any other valid matching evidence can still satisfy the requirement. Review all records for that requirement when withdrawing an operator's qualification. Expiry is evaluated at the requested service time by the existing serviceability gate, and at the current time by the Ops preview. A status marked verified can therefore be effectively expired without a scheduled status rewrite.

Reviews lock the actor row, matching the existing authoritative provider selection lock. The preview is read-only and does not authorize assignments. Capacity, geography, business service authorization and the other serviceability rules still apply. This change does not claim all dispatch/acceptance paths enforce case qualifications; it adds secure administration to the existing routing/selection integration.

Case requirements remain explicitly registered in `case_qualification_requirements` through the existing data contract. This release does not infer requirements from a VIN, provide an issuer catalogue, or add a requirement editing UI. Cases with no requirements preserve their existing workflow. Migration 201 preserves historical evidence without inventing reviewer provenance. A nonvalidated database constraint protects subsequent writes from blank verification sources; the loader also rejects historical blank or whitespace sources.

Validation covers identified administrator access, private registry boundaries, forged metadata rejection, matching evidence and revocation, expiry, no-expiry review, concurrent review conflicts, cross-actor record-ID collisions, immutable subjects, and atomic rollback on audit failure. Migration testing uses an isolated Neon branch before production rollout.
