// ROVIQ Drive intent router.
// Keeps deterministic safety classification ahead of AI. AI is used only for
// ambiguous, non-critical utterances and returns a constrained intent label.

const VEHICLE_CRITICAL = /\b(no brakes|brake failure|brake pedal.*floor|cannot steer|steering locked|steering failure|fire|flames|smoke from engine|burning smell|fuel leak|gasoline leak|strong fuel smell|oil pressure warning|low oil pressure|overheating|temperature gauge.*red|coolant.*boiling|high voltage warning|battery fire|thermal runaway|flashing check engine|engine.*shaking violently)\b/i;
const VEHICLE = /\b(car|vehicle|engine|brake|brakes|steering|tire|tyre|wheel|battery|alternator|transmission|gearbox|coolant|radiator|oil|check engine|warning light|dashboard|vibration|vibrating|shaking|grinding|squealing|rattling|leak|overheat|overheating|won't start|will not start|stall|stalled|misfire)\b/i;
const LOCAL = /\b(coffee|cafe|café|restaurant|food|eat|breakfast|lunch|dinner|park|garden|viewpoint|scenic|attraction|place to stop|rest stop|nearby|near me|driver'?s pick)\b/i;

function normalizeAi(raw) {
  if (typeof raw === 'string') {
    const cleaned = raw.replace(/^\`\`\`(?:json)?\s*/i, '').replace(/\s*\`\`\`$/, '');
    try { return JSON.parse(cleaned); } catch { return {}; }
  }
  return raw && typeof raw === 'object' ? raw : {};
}

export async function classifyDriveIntent(env, utterance, context = {}) {
  const text = String(utterance || '').trim();
  if (!text) return { intent: 'unknown', confidence: 1, source: 'deterministic', reason: 'empty_utterance' };

  // Safety wins over every discovery signal. "Coffee, but my brakes failed" is automotive.
  if (VEHICLE_CRITICAL.test(text)) {
    return { intent: 'vehicle_issue', confidence: 1, source: 'deterministic', safetyCritical: true };
  }

  const vehicle = VEHICLE.test(text);
  const local = LOCAL.test(text);
  if (vehicle && !local) return { intent: 'vehicle_issue', confidence: 0.98, source: 'deterministic', safetyCritical: false };
  if (local && !vehicle) return { intent: 'local_discovery', confidence: 0.98, source: 'deterministic', safetyCritical: false };

  if (!env.AI) return { intent: 'unknown', confidence: 0.2, source: 'fallback', safetyCritical: false };

  try {
    const response = await env.AI.run(env.TRIAGE_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [
        { role: 'system', content: 'Classify a ROVIQ driving assistant utterance. Return JSON only: {"intent":"local_discovery|vehicle_issue|general|unknown","confidence":0..1}. local_discovery means places, coffee, food, scenic stops, attractions or route stops. vehicle_issue means symptoms, warnings, drivability, maintenance, breakdown or repair. Never diagnose the vehicle.' },
        { role: 'user', content: JSON.stringify({ utterance: text, context }) }
      ],
      temperature: 0
    });
    const parsed = normalizeAi(response?.response ?? response);
    const allowed = ['local_discovery', 'vehicle_issue', 'general', 'unknown'];
    return {
      intent: allowed.includes(parsed.intent) ? parsed.intent : 'unknown',
      confidence: Number.isFinite(Number(parsed.confidence)) ? Math.max(0, Math.min(1, Number(parsed.confidence))) : 0.2,
      source: 'workers-ai',
      safetyCritical: false
    };
  } catch {
    return { intent: 'unknown', confidence: 0.2, source: 'fallback', safetyCritical: false };
  }
}

export function localSearchUrl(requestUrl, body) {
  const url = new URL('/api/local/places', requestUrl);
  const q = String(body.query || body.utterance || '').trim();
  if (q) url.searchParams.set('q', q);
  if (body.category) url.searchParams.set('category', String(body.category));
  if (body.lat != null) url.searchParams.set('lat', String(body.lat));
  if (body.lng != null) url.searchParams.set('lng', String(body.lng));
  return url;
}
