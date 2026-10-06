// ROVIQ work assistant for service roles: the person asks in plain words ("show me the nearest
// cases", "take the closest one") and gets an answer built from their own live data.
//
// The model only works out what is being asked. Every job, distance and action comes from Core,
// fetched with the person's own sign-in, so the assistant can never show more than they may see
// and never invents a job. Anything that changes something (accepting a job) comes back as a
// proposal the person confirms with a tap; the assistant itself never acts.

const DEFAULT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const INTENTS = ['list', 'details', 'accept', 'decline', 'help'];
const SORTS = ['nearest', 'urgent', 'newest'];
const FILTERS = ['all', 'offered', 'accepted'];
const URGENCY_RANK = { emergency: 3, urgent: 2, normal: 1 };

const ISSUE_LABELS = {
  wont_start: 'Won’t start', no_start: 'Won’t start', battery: 'Battery', flat_tire: 'Flat tire', brake_repair: 'Brakes',
  check_engine_light: 'Check-engine light', check_engine: 'Check-engine light', oil_change: 'Oil change', ac_heating: 'AC / heating',
  transmission: 'Transmission', overheating: 'Overheating', warning_light: 'Warning light'
};
export const issueLabel = (type) => ISSUE_LABELS[type] ?? String(type || 'Service request').replace(/_/g, ' ').replace(/\b\w/, (c) => c.toUpperCase());

function validPoint(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

/** A {lat,lng} from the shapes ROVIQ stores locations in, or null. */
export function pointOf(value) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value.coordinates) && value.coordinates.length >= 2) {
    const [lng, lat] = value.coordinates.map(Number);
    return validPoint(lat, lng) ? { lat, lng } : null;
  }
  const lat = Number(value.lat ?? value.latitude);
  const lng = Number(value.lng ?? value.lon ?? value.longitude);
  return validPoint(lat, lng) ? { lat, lng } : null;
}

export function distanceKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

/** Keyword reading of a request, used when the model is unavailable and as a sanity check. */
export function intentFromKeywords(text) {
  const t = String(text || '').toLowerCase();
  const number = t.match(/\b(?:job|case|number|#)?\s*(\d{1,2})\b/);
  const job = /\b(closest|nearest)\b/.test(t) ? 'closest' : number ? Number(number[1]) : null;
  const sort = /\burgent|emergenc|priority/.test(t) ? 'urgent' : /\bnew(est)?\b|latest|recent/.test(t) ? 'newest' : 'nearest';
  const filter = /\b(my accepted|accepted|in progress|current)\b/.test(t) ? 'accepted' : /\b(new|offer|offered|waiting|available)\b/.test(t) ? 'offered' : 'all';
  if (/\b(decline|reject|pass on|skip)\b/.test(t)) return { intent: 'decline', sort, filter, job };
  if (/\b(accept|take|grab|claim|i'?ll do)\b/.test(t)) return { intent: 'accept', sort, filter, job };
  if (/\b(detail|tell me (more|about)|what'?s|info|show job|open)\b/.test(t) && job != null) return { intent: 'details', sort, filter, job };
  if (/\b(help|what can you)\b/.test(t)) return { intent: 'help', sort, filter, job };
  return { intent: 'list', sort, filter, job };
}

const INTENT_PROMPT = `You read requests from a ROVIQ field technician to their job assistant.
Return ONLY a JSON object: {"intent": one of ${JSON.stringify(INTENTS)}, "sort": one of ${JSON.stringify(SORTS)}, "filter": one of ${JSON.stringify(FILTERS)}, "job": a job number from the last list, "closest", or null}.
- "list": show jobs (e.g. "show me the nearest cases", "what's urgent?", "anything new?")
- "details": about one job ("tell me about job 2")
- "accept" / "decline": take or turn down an offered job ("take the closest one", "accept 1", "pass on job 3")
- "help": what the assistant can do
"filter": "offered" = new offers waiting for an answer, "accepted" = jobs already taken, otherwise "all".`;

export async function readIntent(env, text) {
  const fallback = intentFromKeywords(text);
  if (!env.AI) return { ...fallback, reader: 'keywords' };
  try {
    const raw = await env.AI.run(env.ASSIST_MODEL || DEFAULT_MODEL, {
      messages: [{ role: 'system', content: INTENT_PROMPT }, { role: 'user', content: String(text).slice(0, 500) }],
      temperature: 0,
      max_tokens: 120
    });
    let value = raw?.response ?? raw;
    if (typeof value === 'string') {
      const start = value.indexOf('{');
      const end = value.lastIndexOf('}');
      value = JSON.parse(value.slice(start, end + 1));
    }
    const job = value?.job === 'closest' ? 'closest' : Number.isInteger(Number(value?.job)) && Number(value.job) > 0 ? Number(value.job) : null;
    return {
      intent: INTENTS.includes(value?.intent) ? value.intent : fallback.intent,
      sort: SORTS.includes(value?.sort) ? value.sort : fallback.sort,
      filter: FILTERS.includes(value?.filter) ? value.filter : fallback.filter,
      job: job ?? fallback.job,
      reader: 'ai'
    };
  } catch {
    return { ...fallback, reader: 'keywords' };
  }
}

/** The signed-in principal Core confirms for this bearer token, or null. */
export async function principalFor(request, env) {
  const auth = request.headers.get('authorization');
  if (!auth || !auth.startsWith('Bearer ') || !env.CORE_API_URL) return null;
  try {
    const res = await fetch(new URL('/api/auth/roles', env.CORE_API_URL), { headers: { authorization: auth } });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.active?.role ? { role: body.active.role, actorId: body.active.actorId ?? null, auth } : null;
  } catch {
    return null;
  }
}

async function diagnosticQueue(env, auth) {
  const res = await fetch(new URL('/api/diagnostics/me/queue', env.CORE_API_URL), { headers: { authorization: auth } });
  if (!res.ok) throw new Error('queue_unavailable');
  return (await res.json()).queue ?? [];
}

/** Jobs as the assistant shows them: numbered in the order given, with distance when both ends are known. */
export function arrangeJobs(queue, here, sort, filter) {
  const jobs = queue
    .filter((q) => filter === 'all' || q.outcome === filter)
    .map((q) => {
      const where = pointOf(q.location);
      return {
        offerId: q.offer_id,
        caseId: q.case_id ?? null,
        issue: issueLabel(q.demand_type),
        urgency: q.urgency ?? 'normal',
        status: q.outcome,
        offeredAt: q.offered_at ?? null,
        distanceKm: here && where ? Math.round(distanceKm(here, where) * 10) / 10 : null
      };
    });
  const byDistance = (a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity);
  const byUrgency = (a, b) => (URGENCY_RANK[b.urgency] ?? 0) - (URGENCY_RANK[a.urgency] ?? 0) || byDistance(a, b);
  const byNewest = (a, b) => String(b.offeredAt ?? '').localeCompare(String(a.offeredAt ?? ''));
  jobs.sort(sort === 'urgent' ? byUrgency : sort === 'newest' ? byNewest : byDistance);
  return jobs.map((job, i) => ({ ref: i + 1, ...job }));
}

const describe = (j) => `${j.ref}. ${j.issue}${j.urgency !== 'normal' ? ` (${j.urgency})` : ''}${j.distanceKm != null ? `, ${j.distanceKm} km away` : ''}${j.status === 'offered' ? ' · new offer' : ' · accepted'}`;

function pick(jobs, job, lastJobs) {
  if (job === 'closest') return [...jobs].sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity))[0] ?? null;
  if (typeof job !== 'number') return null;
  // "Job 2" means the second job in the list the person last saw, if they saw one.
  const offerId = Array.isArray(lastJobs) ? lastJobs[job - 1] : null;
  return (offerId ? jobs.find((j) => j.offerId === offerId) : jobs[job - 1]) ?? null;
}

/** One request to the diagnostic technician's assistant. */
export async function diagnosticTurn(env, principal, body) {
  const text = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!text) return { status: 400, error: 'message_required' };
  const here = pointOf(body.location);
  const ask = await readIntent(env, text);
  let queue;
  try { queue = await diagnosticQueue(env, principal.auth); } catch { return { status: 502, error: 'queue_unavailable' }; }

  if (ask.intent === 'help') {
    return { status: 200, reader: ask.reader, reply: 'Ask me things like “show me the nearest cases”, “what’s urgent?”, “tell me about job 2” or “take the closest one”. I’ll prepare it and you confirm with a tap.', jobs: [] };
  }

  const all = arrangeJobs(queue, here, ask.sort, 'all');
  if (ask.intent === 'accept' || ask.intent === 'decline' || ask.intent === 'details') {
    const offered = all.filter((j) => j.status === 'offered');
    const choices = ask.intent === 'details' ? all : offered;
    // "closest" picks among the jobs that can be acted on; "job 2" means the second job the person
    // last saw; with nothing named and only one candidate, that one.
    let target = ask.job === 'closest' ? pick(choices, 'closest') : pick(all, ask.job, body.lastJobs);
    if (!target && ask.job == null && choices.length === 1) target = choices[0];
    if (!target) {
      const reply = choices.length
        ? `Which one? ${choices.map(describe).join('; ')}.`
        : ask.intent === 'details' ? 'You have no jobs right now.' : 'You have no new offers to answer right now.';
      return { status: 200, reader: ask.reader, reply, jobs: choices };
    }
    if (ask.intent === 'details') {
      return { status: 200, reader: ask.reader, reply: describe(target), jobs: [target] };
    }
    if (target.status !== 'offered') {
      return { status: 200, reader: ask.reader, reply: `${target.issue} is already accepted.`, jobs: [target] };
    }
    const verb = ask.intent === 'accept' ? 'accepted' : 'declined';
    return {
      status: 200,
      reader: ask.reader,
      reply: `${ask.intent === 'accept' ? 'Ready to accept' : 'Ready to decline'}: ${describe(target)}. Confirm below.`,
      jobs: [target],
      proposal: { action: 'respond_offer', offerId: target.offerId, outcome: verb, label: `${ask.intent === 'accept' ? 'Accept' : 'Decline'} ${target.issue}${target.distanceKm != null ? ` (${target.distanceKm} km)` : ''}` }
    };
  }

  const jobs = arrangeJobs(queue, here, ask.sort, ask.filter);
  const what = ask.filter === 'offered' ? 'new offers' : ask.filter === 'accepted' ? 'accepted jobs' : 'jobs';
  const reply = !jobs.length
    ? `You have no ${what} right now.`
    : `${jobs.length === 1 ? `1 ${what.replace(/s$/, '')}` : `${jobs.length} ${what}`}${ask.sort === 'nearest' ? (here ? ', nearest first' : ' (turn on location to sort by distance)') : ask.sort === 'urgent' ? ', most urgent first' : ', newest first'}: ${jobs.map(describe).join('; ')}.`;
  return { status: 200, reader: ask.reader, reply, jobs };
}

/** Entry point: route the request to the assistant for the person's role. */
export async function workTurn(request, env) {
  const principal = await principalFor(request, env);
  if (!principal) return { status: 401, error: 'unauthorized' };
  const body = await request.json().catch(() => ({}));
  if (principal.role === 'diagnostic') return diagnosticTurn(env, principal, body);
  return { status: 200, reply: 'The assistant for your workspace is coming soon. For now it helps diagnostic technicians find and take nearby jobs.', jobs: [] };
}
