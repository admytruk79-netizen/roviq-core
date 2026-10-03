// ROVIQ intake assistant: the customer describes the problem in a conversation (typed or dictated)
// and the assistant asks one follow-up at a time, like a service advisor, while building the case
// draft the "Start service" form submits. It never diagnoses or prices; the technician does.
// Fixed safety rules run on everything the customer says and override the model.

export const ISSUE_TYPES = ['brake_repair', 'wont_start', 'oil_change', 'check_engine_light', 'flat_tire', 'battery', 'ac_heating', 'transmission', 'other'];
const URGENCY = ['normal', 'urgent', 'emergency'];
const DRIVABLE = ['yes', 'no', 'unsure'];
const MAX_MESSAGES = 24;
const MAX_MESSAGE_CHARS = 1500;
const DEFAULT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

const SAFETY_RULES = [
  ['fire_or_smoke', /\b(fire|flames|smoke|smoking|burning smell)\b/],
  ['fuel_leak', /\b(fuel leak|gas leak|gasoline leak|leaking (gas|fuel)|smells? (like|of) (gas|fuel))\b/],
  ['brake_failure', /\b(no brakes|brakes? (failed|failure|not working|don'?t work|went out)|pedal (goes |went |sinks |drops )?(all the way )?to the floor)\b/],
  ['steering_failure', /\b(steering (locked|failed|failure)|can'?t steer|cannot steer)\b/],
  ['overheating', /\b(overheat\w*|temperature gauge.*red|coolant.*boil\w*|steam from)\b/],
  ['ev_high_voltage', /\b(high voltage warning|battery fire|thermal runaway)\b/],
  ['crash', /\b(crash|collision|accident|hit (a|another|by))\b/]
];

export function safetyFlags(text) {
  const t = String(text || '').toLowerCase();
  return SAFETY_RULES.filter(([, re]) => re.test(t)).map(([code]) => code);
}

const SYSTEM_PROMPT = `You are ROVIQ's service intake assistant, talking with a driver whose vehicle has a problem.
Goal: understand the problem well enough to send the right help (mobile diagnostic technician, tow, or shop).
Rules:
- Reply in the same language the customer writes in. Keep replies short and friendly: one question at a time, at most two sentences.
- Ask about what matters: what happens, since when, warning lights, sounds or smells, whether the vehicle can be driven safely.
- Never claim a definitive diagnosis, never quote prices, never promise times. You may name the likely area ("sounds like it could be the battery or starter").
- If anything sounds dangerous (smoke, fuel smell, no brakes, overheating, a crash), tell them to stop driving, stay safe and away from traffic.
- Only record what the customer actually said. If an answer does not answer your question, do not assume; ask again or leave it out. When unsure whether it can be driven, use "unsure".
- When you understand the problem (usually after 2-4 questions), set ready to true and, in the customer's language, read the summary back in one or two sentences and ask them to check it below and send it.
Respond with ONLY one JSON object, no markdown:
{"reply": string,
 "draft": {"issueType": one of ${JSON.stringify(ISSUE_TYPES)},
           "summary": string (in English, 1-3 sentences for the technician: symptoms, when, conditions),
           "likelyArea": string (in English, e.g. "battery or starter"; "" if unclear),
           "drivable": "yes" | "no" | "unsure",
           "urgency": "normal" | "urgent" | "emergency"},
 "ready": boolean}`;

function clean(messages) {
  if (!Array.isArray(messages)) return null;
  const out = messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }));
  if (!out.length || out[out.length - 1].role !== 'user') return null;
  return out;
}

function parseModel(raw) {
  let value = raw?.response ?? raw;
  if (typeof value === 'string') {
    const text = value.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    value = JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text);
  }
  return value && typeof value === 'object' ? value : {};
}

function normalizeDraft(d, customerText) {
  const draft = d && typeof d === 'object' ? d : {};
  return {
    issueType: ISSUE_TYPES.includes(draft.issueType) ? draft.issueType : 'other',
    summary: String(draft.summary || customerText).slice(0, 800),
    likelyArea: String(draft.likelyArea || '').slice(0, 120),
    drivable: DRIVABLE.includes(draft.drivable) ? draft.drivable : 'unsure',
    urgency: URGENCY.includes(draft.urgency) ? draft.urgency : 'normal'
  };
}

const SAFETY_NOTE = 'For your safety, please don’t drive the vehicle. If you are on the road, move away from traffic and turn on your hazard lights. We’ll send help that can tow it.';

/** One conversation turn. Returns { reply, draft, ready, safetyFlags, assistant: 'ai' | 'fallback' }. */
export async function intakeTurn(env, messages) {
  const conversation = clean(messages);
  if (!conversation) return { error: 'messages_invalid', status: 400 };
  const customerText = conversation.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
  const flags = safetyFlags(customerText);

  let reply;
  let draft;
  let ready = false;
  let assistant = 'ai';
  try {
    if (!env.AI) throw new Error('workers_ai_not_bound');
    const raw = await env.AI.run(env.ASSIST_MODEL || DEFAULT_MODEL, {
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...conversation],
      temperature: 0.2,
      max_tokens: 500
    });
    const parsed = parseModel(raw);
    reply = typeof parsed.reply === 'string' && parsed.reply.trim() ? parsed.reply.trim().slice(0, 600) : null;
    draft = normalizeDraft(parsed.draft, customerText);
    ready = parsed.ready === true;
    if (!reply) throw new Error('empty_reply');
  } catch {
    // The model is unavailable or answered badly: keep the conversation going and let the customer
    // send what they wrote. Nothing is lost; the technician reads their own words.
    assistant = 'fallback';
    draft = normalizeDraft(null, customerText);
    const turns = conversation.filter((m) => m.role === 'user').length;
    ready = turns >= 2;
    reply = turns >= 2
      ? 'Thanks. Check the summary below and send it, and a ROVIQ technician will take it from here.'
      : 'Thanks. Can you tell me a bit more: when did it start, and can the vehicle be driven safely?';
  }

  // Fixed safety rules override the model: anything dangerous is not drivable and urgent.
  if (flags.length) {
    draft.drivable = 'no';
    draft.urgency = 'emergency';
    if (!reply.includes(SAFETY_NOTE)) reply = `${SAFETY_NOTE}\n\n${reply}`;
  }
  return { status: 200, reply, draft, ready, safetyFlags: flags, assistant };
}

/** True when Core confirms the bearer token belongs to an active sign-in with one of these roles. */
export async function signedInAs(request, env, roles) {
  const auth = request.headers.get('authorization');
  if (!auth || !auth.startsWith('Bearer ') || !env.CORE_API_URL) return false;
  try {
    const response = await fetch(new URL('/api/auth/roles', env.CORE_API_URL), { headers: { authorization: auth } });
    if (!response.ok) return false;
    const body = await response.json();
    return roles.includes(body?.active?.role);
  } catch {
    return false;
  }
}

/**
 * What to triage once a new case exists: the customer's own words plus the issue they picked.
 * Returns null when the request did not create a case.
 */
export function triageInputFromDemand(requestBody, responseBody) {
  const caseId = responseBody?.case?.id;
  if (!caseId || typeof caseId !== 'string') return null;
  const body = requestBody && typeof requestBody === 'object' ? requestBody : {};
  const attributes = body.attributes && typeof body.attributes === 'object' ? body.attributes : {};
  const symptoms = [
    body.demandType ? `Reported issue: ${String(body.demandType).replace(/_/g, ' ')}` : '',
    typeof attributes.description === 'string' ? attributes.description : ''
  ].filter(Boolean).join('. ').slice(0, 4000);
  if (!symptoms) return null;
  return { caseId, symptoms, vehicle: body.vehicle && typeof body.vehicle === 'object' ? body.vehicle : {}, observations: { urgency: body.urgency ?? null } };
}
