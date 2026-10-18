// ELM-compatible, headerless responses only. Native transport must configure
// ATH0/ATS1 and collect each complete response through the '>' prompt.
export const READ_ONLY_COMMANDS = Object.freeze(['ATI', 'ATE0', 'ATL0', 'ATH0', 'ATS1', 'ATSP0', '0100', '0101', '0105', '010C', '010D', '03']);
export function allowedObdCommand(command) {
  if (!READ_ONLY_COMMANDS.includes(command)) throw new Error('obd_command_not_allowed');
  return `${command}\r`;
}

function payloads(raw, command, prefix) {
  if (typeof raw !== 'string' || raw.length > 16384 || !raw.trim().endsWith('>')) throw new Error('obd_response_incomplete');
  const lines = raw.replace(/>/g, '').split(/[\r\n]+/).map(x => x.trim()).filter(Boolean);
  const frames = [];
  for (const line of lines) {
    if (line.replace(/\s/g, '').toUpperCase() === command || line === 'SEARCHING...') continue;
    if (/NO DATA|STOPPED|UNABLE TO CONNECT|BUS ERROR|CAN ERROR|ERROR|\?/i.test(line)) throw new Error('obd_read_failed');
    const hex = line.replace(/\s/g, '').toUpperCase();
    if (!/^(?:[0-9A-F]{2})+$/.test(hex) || !hex.startsWith(prefix)) throw new Error('obd_response_unsupported');
    frames.push(hex.match(/../g).map(x => parseInt(x, 16)));
  }
  if (!frames.length) throw new Error('obd_read_failed');
  return frames;
}

export function decodeStoredDtcs(raw) {
  const codes = [];
  for (const frame of payloads(raw, '03', '43')) {
    let bytes = frame.slice(1);
    // Some CAN adapters include a DTC count; accept only a matching count.
    if (bytes.length % 2 === 1) {
      const count = bytes.shift();
      if (count * 2 !== bytes.length) throw new Error('obd_dtc_count_mismatch');
    }
    for (let i = 0; i < bytes.length; i += 2) {
      const a = bytes[i], b = bytes[i + 1];
      if (a === 0 && b === 0) continue;
      codes.push('PCBU'[a >> 6] + ((a >> 4) & 3) + (a & 15).toString(16).toUpperCase() + b.toString(16).padStart(2, '0').toUpperCase());
    }
  }
  return [...new Set(codes)];
}

export function decodePid(raw, pid) {
  const sizes = { '01': 4, '05': 1, '0C': 2, '0D': 1, '00': 4 };
  if (!(pid in sizes)) throw new Error('obd_pid_not_supported');
  const frames = payloads(raw, `01${pid}`, `41${pid}`);
  if (frames.length !== 1) throw new Error('obd_multiple_ecus_require_review');
  const data = frames[0].slice(2);
  if (data.length !== sizes[pid]) throw new Error('obd_pid_length_mismatch');
  if (pid === '01') return { milOn: Boolean(data[0] & 128), reportedDtcCount: data[0] & 127 };
  if (pid === '05') return { coolantTemperatureC: data[0] - 40 };
  if (pid === '0C') return { engineRpm: (data[0] * 256 + data[1]) / 4 };
  if (pid === '0D') return { vehicleSpeedKmh: data[0] };
  const bits = ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]) >>> 0;
  return { supportedPids: Array.from({ length: 32 }, (_, i) => i + 1).filter(i => (bits >>> (32 - i)) & 1) };
}

export function createHealthEvent(context, scan) {
  for (const key of ['vehicleId', 'sourceId', 'enrollmentId', 'serviceCaseId']) {
    if (typeof context[key] !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(context[key])) throw new Error('obd_binding_required');
  }
  if (typeof scan.scanId !== 'string' || !scan.scanId || scan.scanId.length > 250 || !Number.isFinite(Date.parse(scan.observedAt))) throw new Error('obd_scan_identity_required');
  const dtcCodes = decodeStoredDtcs(scan.dtcResponse);
  const normalizedSignals = {};
  for (const [pid, raw] of Object.entries(scan.pidResponses ?? {})) Object.assign(normalizedSignals, decodePid(raw, pid));
  return { ...context, sourceEventId: scan.scanId, eventType: 'obd_scan', occurredAt: scan.observedAt,
    dtcCodes, normalizedSignals, severity: 'advisory', safetyState: 'review_required',
    rawReference: {}, metadata: { transport: 'bluetooth_classic', adapterProfile: 'elm_headerless', readOnly: true } };
}

// The caller retains the same scanId and observedAt when retrying. Core owns
// vehicle consent, enrollment validation, case access and event deduplication.
export async function uploadAndAnalyzeScan({ token, context, scan, apiBase }) {
  const base = new URL(apiBase);
  if (base.protocol !== 'https:' || !['roviq-core.admytruk79.workers.dev', 'roviq-core.onrender.com'].includes(base.hostname)
      || base.username || base.password || base.port) throw new Error('obd_api_not_trusted');
  if (typeof token !== 'string' || !token.trim()) throw new Error('obd_sign_in_required');
  const event = createHealthEvent(context, scan);
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const uploaded = await fetch(new URL('/api/connected/health-events', base), { method: 'POST', headers,
    body: JSON.stringify(event), signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!uploaded.ok) throw new Error(`obd_ingestion_rejected_${uploaded.status}`);
  const saved = await uploaded.json();
  if (!saved?.event?.id) throw new Error('obd_ingestion_response_invalid');
  try {
    const analyzed = await fetch(new URL('/api/connected/obd-analysis', base), {
      method: 'POST', headers, signal: AbortSignal.timeout(20000), redirect: 'error',
      body: JSON.stringify({eventId: saved.event.id, caseId: context.serviceCaseId})
    });
    if (!analyzed.ok) return { event: saved.event, analysisPending: true, analysis: null };
    const response = await analyzed.json();
    return {event: saved.event, analysisPending: response.analysisPending !== false,
      analysis: response.job?.result ?? null, analysisState: response.job?.state ?? 'pending',
      assessmentId: response.job?.assessment_id ?? null};
  } catch { return { event: saved.event, analysisPending: true, analysis: null }; }
}
