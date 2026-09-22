export type DeterministicSafetyMatch = { code: string; rationale: string };

export type DeterministicSafetyResult = {
  matched: boolean;
  reason: string | null;
  matches: DeterministicSafetyMatch[];
};

// Mirrors the free-text categories in triage-engine.ts's deterministicSafety, so a connected
// vehicle-health event reaches the same stop-driving conclusion an AI/human triage conversation
// would for the same underlying condition. Fire/smoke, fuel leak and brake/steering failure don't
// have a clean generic OBD-II code, so they're caught via the same text patterns applied to
// whatever free text the source did send (eventType, metadata notes).
const CRITICAL_TEXT_PATTERNS = [
  ['fire_or_smoke', /\b(fire|flames|smoke from engine|burning smell)\b/],
  ['fuel_leak', /\b(fuel leak|gasoline leak|strong fuel smell|smells like gas)\b/],
  ['brake_failure', /\b(no brakes|brake failure|brake pedal.*floor)\b/],
  ['steering_failure', /\b(steering locked|cannot steer|steering failure)\b/]
] as const;

// Generic (SAE-standard), manufacturer-independent DTC patterns with a well-established safety
// meaning. Deliberately small and conservative: a code outside this list doesn't force an
// override, it just passes the source's own severity through -- this is a safety floor under
// self-reported data, not a full automotive diagnostic classifier.
const CRITICAL_DTC_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['engine_overheat', /^P0217$/i],
  ['random_multiple_misfire', /^P0300$/i],
  ['low_oil_pressure', /^P052[0-4]$/i],
  ['hybrid_ev_high_voltage', /^P0A/i]
];

/**
 * A connected-vehicle source (Reader, OEM feed, or the customer's own app) reports its own
 * severity/safetyState, but that report is evidence, not authority -- the same principle the AI
 * triage path already enforces for free-text symptoms. This recomputes an independent safety
 * floor from the DTC codes and event text Core actually received, so a source cannot understate
 * (accidentally or otherwise) a condition Core can already recognize as critical.
 */
export function evaluateVehicleHealthSafety(input: {
  dtcCodes: string[];
  eventType: string;
  normalizedSignals: Record<string, unknown>;
  metadata: Record<string, unknown>;
}): DeterministicSafetyResult {
  const matches: DeterministicSafetyMatch[] = [];
  for (const code of input.dtcCodes) {
    const hit = CRITICAL_DTC_PATTERNS.find(([, pattern]) => pattern.test(code));
    if (hit) matches.push({ code: hit[0], rationale: `Deterministic safety rule matched DTC ${code.toUpperCase()}.` });
  }
  const text = `${input.eventType} ${JSON.stringify(input.normalizedSignals)} ${JSON.stringify(input.metadata)}`.toLowerCase();
  for (const [code, pattern] of CRITICAL_TEXT_PATTERNS) {
    if (pattern.test(text)) matches.push({ code, rationale: 'Deterministic safety rule matched reported event text.' });
  }
  return {
    matched: matches.length > 0,
    reason: matches.length ? matches.map((match) => match.code).join(',') : null,
    matches
  };
}
