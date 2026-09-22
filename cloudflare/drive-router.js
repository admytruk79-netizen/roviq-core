// ROVIQ Drive intent router.
// One conversational gateway for the existing adaptive front end.
// Deterministic safety classification always runs before AI classification.

const VEHICLE_CRITICAL = /\b(no brakes|brake failure|brake pedal.*floor|cannot steer|steering locked|steering failure|fire|flames|smoke from engine|burning smell|fuel leak|gasoline leak|strong fuel smell|oil pressure warning|low oil pressure|overheating|temperature gauge.*red|coolant.*boiling|high voltage warning|battery fire|thermal runaway|flashing check engine|engine.*shaking violently)\b/i;
const VEHICLE = /\b(car|vehicle|engine|brake|brakes|steering|tire|tyre|wheel|battery|alternator|transmission|gearbox|coolant|radiator|oil|check engine|warning light|dashboard|vibration|vibrating|shaking|grinding|squealing|rattling|leak|overheat|overheating|won't start|will not start|stall|stalled|misfire|repair|service|maintenance|mechanic)\b/i;
const LOCAL = /\b(coffee|cafe|café|restaurant|food|eat|breakfast|lunch|dinner|park|garden|viewpoint|scenic|attraction|hidden gem|place to stop|rest stop|nearby|near me|driver'?s pick|explore|wild)\b/i;
const JOURNEY = /\b(route|trip|journey|destination|on my way|along the way|on the way|ahead|detour|next stop|saved trip)\b/i;
const DISPATCH = /\b(dispatch|dispatcher|unassigned|waiting cases?|assign|reassign|queue|exception|escalation)\b/i;
const TOW = /\b(tow|towing|pickup|drop[- ]?off|recovery|flatbed|winch|eta|arrived)\b/i;
const SHOP = /\b(shop|dealership|bay|technician|estimate|repair order|work order|appointment|capacity|parts order)\b/i;
const FLEET = /\b(fleet|vehicles? down|downtime|loaner|rental inventory|fleet vehicle)\b/i;

export const DRIVE_INTENTS = [
  'local_discovery',
  'vehicle_issue',
  'service',
  'dispatch',
  'tow',
  'shop',
  'fleet',
  'journey',
  'mixed',
  'general',
  'unknown'
];

function normalizeAi(raw) {
  if (typeof raw === 'string') {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { return JSON.parse(cleaned); } catch { return {}; }
  }
  return raw && typeof raw === 'object' ? raw : {};
}

function deterministicSignals(text) {
  return {
    vehicle: VEHICLE.test(text),
    local: LOCAL.test(text),
    journey: JOURNEY.test(text),
    dispatch: DISPATCH.test(text),
    tow: TOW.test(text),
    shop: SHOP.test(text),
    fleet: FLEET.test(text)
  };
}

export async function classifyDriveIntent(env, utterance, context = {}) {
  const text = String(utterance || '').trim();
  if (!text) return { intent: 'unknown', confidence: 1, source: 'deterministic', reason: 'empty_utterance' };

  // Critical vehicle safety always wins, even when the utterance also asks for a place or route.
  if (VEHICLE_CRITICAL.test(text)) {
    return { intent: 'vehicle_issue', confidence: 1, source: 'deterministic', safetyCritical: true };
  }

  const s = deterministicSignals(text);
  const signalCount = Object.values(s).filter(Boolean).length;

  // Mixed vehicle + Local/Journey requests are preserved instead of losing either requirement.
  if (s.vehicle && (s.local || s.journey)) {
    return {
      intent: 'mixed',
      confidence: 0.99,
      source: 'deterministic',
      safetyCritical: false,
      components: ['vehicle_issue', ...(s.local ? ['local_discovery'] : []), ...(s.journey ? ['journey'] : [])]
    };
  }

  if (signalCount === 1) {
    if (s.dispatch) return { intent: 'dispatch', confidence: 0.98, source: 'deterministic', safetyCritical: false };
    if (s.tow) return { intent: 'tow', confidence: 0.98, source: 'deterministic', safetyCritical: false };
    if (s.shop) return { intent: 'shop', confidence: 0.98, source: 'deterministic', safetyCritical: false };
    if (s.fleet) return { intent: 'fleet', confidence: 0.98, source: 'deterministic', safetyCritical: false };
    if (s.journey) return { intent: 'journey', confidence: 0.98, source: 'deterministic', safetyCritical: false };
    if (s.vehicle) return { intent: 'vehicle_issue', confidence: 0.98, source: 'deterministic', safetyCritical: false };
    if (s.local) return { intent: 'local_discovery', confidence: 0.98, source: 'deterministic', safetyCritical: false };
  }

  if (!env.AI) return { intent: 'unknown', confidence: 0.2, source: 'fallback', safetyCritical: false };

  try {
    const response = await env.AI.run(env.TRIAGE_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [
        {
          role: 'system',
          content: 'Classify a ROVIQ utterance for one adaptive multi-actor application. Return JSON only: {"intent":"local_discovery|vehicle_issue|service|dispatch|tow|shop|fleet|journey|mixed|general|unknown","confidence":0..1,"components":[]}. local_discovery=places/coffee/food/scenic/local discovery. vehicle_issue=symptoms/warnings/drivability/breakdown. service=creating or managing vehicle service. dispatch=case queues/assignment/exceptions. tow=tow operator logistics. shop=shop/dealership work/capacity/estimates. fleet=fleet vehicles/downtime/loaners. journey=route/trip/destination context. mixed=two or more operational domains in one request. Never diagnose a vehicle and never infer that the user has permission to perform an action.'
        },
        { role: 'user', content: JSON.stringify({ utterance: text, context }) }
      ],
      temperature: 0
    });
    const parsed = normalizeAi(response?.response ?? response);
    return {
      intent: DRIVE_INTENTS.includes(parsed.intent) ? parsed.intent : 'unknown',
      confidence: Number.isFinite(Number(parsed.confidence)) ? Math.max(0, Math.min(1, Number(parsed.confidence))) : 0.2,
      source: 'workers-ai',
      safetyCritical: false,
      components: Array.isArray(parsed.components) ? parsed.components.filter((x) => DRIVE_INTENTS.includes(x)).slice(0, 5) : []
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
