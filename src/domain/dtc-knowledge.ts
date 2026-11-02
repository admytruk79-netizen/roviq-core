// Deterministic fault-code knowledge shared by the Core triage engine, the MACRE requirement
// suggestions and the Cloudflare OBD analysis (which imports this file directly, so it must stay
// dependency-free and use only erasable TypeScript syntax).
//
// Everything here is advisory. A code says what the vehicle's computer observed, not what is
// broken: findings name systems and checks, never a confirmed cause, and every rule cites the
// exact recorded code or measurement it came from. Manufacturer-specific codes are reported as
// such and need OEM information before anyone interprets them.

export type DtcDomain = 'powertrain' | 'body' | 'chassis' | 'network';
export type Severity = 'info' | 'warning' | 'critical';

export type DtcFinding = {
  code: string;
  domain: DtcDomain;
  system: string;
  manufacturerSpecific: boolean;
  description: string | null;
};

export type SafetyFlag = { code: string; severity: Severity; rationale: string; evidence: string[] };

export type QualificationSuggestion = {
  requirementKey: string;
  kind: 'legal_license' | 'oem_certification' | 'manufacturer_access' | 'training' | 'equipment';
  label: string;
  mandatory: boolean;
  rationale: string;
  evidence: string[];
};

export type ObdSynthesis = {
  findings: DtcFinding[];
  invalidCodes: string[];
  systems: string[];
  safetyFlags: SafetyFlag[];
  capabilities: string[];
  recommendedChecks: string[];
  missingInformation: string[];
  summary: string;
};

// SAE J2012 generic definitions for codes a scanner commonly reports. Codes outside this list
// still get a system from their number range.
const GENERIC: Record<string, string> = {
  P0010: 'Intake camshaft position actuator circuit (bank 1)',
  P0011: 'Intake camshaft timing over-advanced or system performance (bank 1)',
  P0016: 'Crankshaft/camshaft position correlation (bank 1, sensor A)',
  P0087: 'Fuel rail/system pressure too low',
  P0101: 'Mass air flow sensor circuit range/performance',
  P0102: 'Mass air flow sensor circuit low',
  P0106: 'Manifold absolute pressure sensor circuit range/performance',
  P0113: 'Intake air temperature sensor 1 circuit high',
  P0117: 'Engine coolant temperature sensor 1 circuit low',
  P0118: 'Engine coolant temperature sensor 1 circuit high',
  P0121: 'Throttle/pedal position sensor A circuit range/performance',
  P0128: 'Coolant temperature below thermostat regulating temperature',
  P0131: 'O2 sensor circuit low voltage (bank 1, sensor 1)',
  P0133: 'O2 sensor circuit slow response (bank 1, sensor 1)',
  P0135: 'O2 sensor heater circuit (bank 1, sensor 1)',
  P0141: 'O2 sensor heater circuit (bank 1, sensor 2)',
  P0171: 'System too lean (bank 1)',
  P0172: 'System too rich (bank 1)',
  P0174: 'System too lean (bank 2)',
  P0175: 'System too rich (bank 2)',
  P0217: 'Engine coolant over-temperature condition',
  P0219: 'Engine overspeed condition',
  P0300: 'Random/multiple cylinder misfire detected',
  P0301: 'Cylinder 1 misfire detected',
  P0302: 'Cylinder 2 misfire detected',
  P0303: 'Cylinder 3 misfire detected',
  P0304: 'Cylinder 4 misfire detected',
  P0305: 'Cylinder 5 misfire detected',
  P0306: 'Cylinder 6 misfire detected',
  P0307: 'Cylinder 7 misfire detected',
  P0308: 'Cylinder 8 misfire detected',
  P0325: 'Knock sensor 1 circuit (bank 1)',
  P0335: 'Crankshaft position sensor A circuit',
  P0340: 'Camshaft position sensor A circuit (bank 1)',
  P0401: 'Exhaust gas recirculation flow insufficient',
  P0402: 'Exhaust gas recirculation flow excessive',
  P0420: 'Catalyst system efficiency below threshold (bank 1)',
  P0430: 'Catalyst system efficiency below threshold (bank 2)',
  P0440: 'Evaporative emission system malfunction',
  P0441: 'Evaporative emission system incorrect purge flow',
  P0442: 'Evaporative emission system leak detected (small leak)',
  P0446: 'Evaporative emission system vent control circuit',
  P0455: 'Evaporative emission system leak detected (large leak)',
  P0456: 'Evaporative emission system leak detected (very small leak)',
  P0480: 'Fan 1 control circuit',
  P0500: 'Vehicle speed sensor A',
  P0505: 'Idle air control system',
  P0506: 'Idle control system RPM lower than expected',
  P0507: 'Idle control system RPM higher than expected',
  P0520: 'Engine oil pressure sensor/switch circuit',
  P0524: 'Engine oil pressure too low',
  P0562: 'System voltage low',
  P0563: 'System voltage high',
  P0571: 'Brake switch A circuit',
  P0600: 'Serial communication link',
  P0601: 'Internal control module memory checksum error',
  P0606: 'Control module processor',
  P0700: 'Transmission control system (MIL request)',
  P0715: 'Input/turbine speed sensor A circuit',
  P0730: 'Incorrect gear ratio',
  P0740: 'Torque converter clutch circuit',
  P0741: 'Torque converter clutch circuit performance or stuck off',
  P0750: 'Shift solenoid A',
  P0A80: 'Replace hybrid battery pack',
  P0AA6: 'Hybrid battery voltage system isolation fault',
  U0073: 'Control module communication bus A off',
  U0100: 'Lost communication with ECM/PCM A',
  U0101: 'Lost communication with TCM',
  U0121: 'Lost communication with anti-lock brake system control module',
  U0140: 'Lost communication with body control module',
  U0151: 'Lost communication with restraints control module',
  U0155: 'Lost communication with instrument panel cluster control module'
};

const DOMAIN: Record<string, DtcDomain> = { P: 'powertrain', B: 'body', C: 'chassis', U: 'network' };
const CODE = /^[PBCU][0-3][0-9A-F]{3}$/;

function powertrainSystem(code: string): string {
  const group = code.slice(2, 3);
  if (code[1] === '0' && ['A', 'B', 'C'].includes(group)) return 'Hybrid/EV propulsion';
  switch (group) {
    case '0': case '1': case '2': return 'Fuel and air metering';
    case '3': return 'Ignition / misfire';
    case '4': return 'Emission controls';
    case '5': return 'Speed, idle and auxiliary inputs';
    case '6': return 'Control module and output circuits';
    case '7': case '8': case '9': return 'Transmission';
    default: return 'Powertrain';
  }
}

/** Classify one code. Returns null for anything that is not a well-formed five-character DTC. */
export function parseDtc(raw: string): DtcFinding | null {
  const code = String(raw ?? '').trim().toUpperCase();
  if (!CODE.test(code)) return null;
  const domain = DOMAIN[code[0]!]!;
  // P1/P3 and B1/B2/C1/C2/U1/U2 are manufacturer-controlled ranges.
  const manufacturerSpecific = code[0] === 'P' ? code[1] === '1' || code[1] === '3' : code[1] === '1' || code[1] === '2';
  let system: string;
  if (domain === 'powertrain') system = powertrainSystem(code);
  else if (domain === 'body') system = !manufacturerSpecific && code.slice(1, 3) === '00' ? 'Restraints (airbags/SRS)' : 'Body systems';
  else if (domain === 'chassis') system = 'Chassis (brakes, ABS, stability, steering, suspension)';
  else system = 'Vehicle network / module communication';
  return { code, domain, system, manufacturerSpecific, description: manufacturerSpecific ? null : GENERIC[code] ?? null };
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const inRange = (code: string, from: string, to: string) => code >= from && code <= to;

/**
 * Turn recorded codes and measurements into findings, safety flags, needed capabilities and
 * checks. Pure and deterministic: the same evidence always gives the same answer.
 */
export function synthesizeObdEvidence(input: { dtcCodes?: unknown; signals?: unknown }): ObdSynthesis {
  const rawCodes = Array.isArray(input.dtcCodes) ? input.dtcCodes.filter((c): c is string => typeof c === 'string') : [];
  const signals = input.signals && typeof input.signals === 'object' ? (input.signals as Record<string, unknown>) : {};
  const findings: DtcFinding[] = [];
  const invalidCodes: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawCodes.slice(0, 100)) {
    const f = parseDtc(raw);
    if (!f) { invalidCodes.push(String(raw).slice(0, 32)); continue; }
    if (seen.has(f.code)) continue;
    seen.add(f.code); findings.push(f);
  }
  const codes = findings.map((f) => f.code);
  const any = (test: (c: string) => boolean) => codes.filter(test);

  const flags: SafetyFlag[] = [];
  const flag = (code: string, severity: Severity, rationale: string, evidence: string[]) => {
    if (evidence.length) flags.push({ code, severity, rationale, evidence });
  };
  const coolant = num(signals.coolantTemperatureC);
  flag('overheating', 'critical', 'Engine over-temperature recorded. Continuing to drive can cause severe engine damage.',
    [...any((c) => c === 'P0217'), ...(coolant !== null && coolant >= 115 ? [`coolantTemperatureC=${coolant}`] : [])]);
  flag('oil_pressure', 'critical', 'Low engine oil pressure recorded. Running the engine can destroy it within minutes.', any((c) => c === 'P0524'));
  flag('ev_high_voltage', 'critical', 'High-voltage isolation fault recorded. Only trained technicians should touch the high-voltage system.', any((c) => c === 'P0AA6'));
  flag('misfire', 'warning', 'Misfire recorded. A flashing check-engine light means stop driving: unburned fuel can overheat the catalytic converter.',
    any((c) => inRange(c, 'P0300', 'P0312')));
  flag('srs_restraint', 'warning', 'Airbag/restraint fault recorded. Airbags may not deploy in a crash.',
    [...findings.filter((f) => f.system.startsWith('Restraints')).map((f) => f.code), ...any((c) => c === 'U0151')]);
  flag('chassis_control', 'warning', 'Chassis control fault recorded. ABS, stability or steering assistance may be reduced.',
    [...findings.filter((f) => f.domain === 'chassis').map((f) => f.code), ...any((c) => c === 'U0121')]);
  flag('hybrid_battery', 'warning', 'Hybrid/EV propulsion fault recorded. Power may be limited.',
    findings.filter((f) => f.system === 'Hybrid/EV propulsion' && f.code !== 'P0AA6').map((f) => f.code));
  flag('transmission', 'warning', 'Transmission fault recorded. The vehicle may hold one gear or shift harshly.',
    findings.filter((f) => f.system === 'Transmission').map((f) => f.code));
  flag('oil_pressure_sensor', 'info', 'Oil pressure sensor circuit fault recorded. Confirm actual oil pressure with a gauge before driving far.',
    any((c) => inRange(c, 'P0520', 'P0523')));
  flag('engine_overspeed', 'info', 'Engine overspeed recorded.', any((c) => c === 'P0219'));
  flag('charging_voltage', 'info', 'Abnormal system voltage recorded. Check battery and charging system.', any((c) => c === 'P0562' || c === 'P0563'));

  const checks: string[] = [];
  const check = (when: boolean, text: string) => { if (when && !checks.includes(text)) checks.push(text); };
  check(codes.some((c) => inRange(c, 'P0300', 'P0312')), 'Read misfire counters per cylinder; swap-test coil/plug on the flagged cylinder and check compression if it follows the cylinder.');
  check(codes.some((c) => ['P0171', 'P0174', 'P0172', 'P0175'].includes(c)), 'Review short- and long-term fuel trims; smoke-test for intake/vacuum leaks and check MAF readings.');
  check(codes.some((c) => c === 'P0420' || c === 'P0430'), 'Rule out misfires, exhaust leaks and O2 sensor faults before condemning the catalytic converter.');
  check(codes.some((c) => inRange(c, 'P0440', 'P0457')), 'Inspect the fuel cap seal, then smoke-test the EVAP system.');
  check(codes.some((c) => c === 'P0128' || c === 'P0217') || (coolant !== null && coolant >= 115), 'Check coolant level, thermostat operation, cooling fan and for leaks with the engine cold.');
  check(codes.some((c) => c === 'P0524' || inRange(c, 'P0520', 'P0523')), 'Check oil level and confirm oil pressure with a mechanical gauge before running the engine.');
  check(findings.some((f) => f.system === 'Transmission'), 'Check transmission fluid level/condition and read transmission data with a capable scan tool.');
  check(findings.some((f) => f.domain === 'network'), 'Check power, ground and network wiring of the module that stopped communicating before replacing it.');
  check(findings.some((f) => f.system.startsWith('Restraints')), 'Follow the OEM restraint-system service procedure (power down and wait) before any SRS diagnosis.');
  check(findings.some((f) => f.system === 'Hybrid/EV propulsion'), 'High-voltage diagnosis only with HV-safety procedures, insulated tools and the OEM procedure.');
  check(findings.some((f) => f.domain === 'chassis'), 'Read chassis module codes and live wheel-speed data; inspect sensor wiring and tone rings.');
  check(findings.some((f) => f.manufacturerSpecific), 'Look up manufacturer-specific codes in OEM service information for this exact vehicle.');

  const capabilities = ['diagnostics'];
  if (flags.some((f) => f.severity === 'critical')) capabilities.push('tow');
  if (findings.length) capabilities.push('repair');

  const missing: string[] = [];
  if (!findings.length && !invalidCodes.length) missing.push('No stored codes were reported; that alone does not show the vehicle is healthy');
  if (findings.some((f) => f.manufacturerSpecific)) missing.push('Confirmed make, model, year and engine for manufacturer-specific codes');
  if (findings.some((f) => !f.manufacturerSpecific && !f.description)) missing.push('Generic definition for codes outside the built-in reference');
  if (coolant === null && findings.some((f) => ['P0128', 'P0217'].includes(f.code))) missing.push('Live coolant temperature');
  missing.push('Freeze-frame data and technician test results');

  const systems = [...new Set(findings.map((f) => f.system))];
  const described = findings.slice(0, 6).map((f) => (f.description ? `${f.code} (${f.description})` : `${f.code} (${f.system}${f.manufacturerSpecific ? ', manufacturer-specific' : ''})`));
  const summary = findings.length
    ? `Recorded ${findings.length} code${findings.length === 1 ? '' : 's'}: ${described.join('; ')}${findings.length > 6 ? '; …' : ''}. These show what the vehicle detected, not a confirmed cause.`
    : 'No stored fault codes were recorded in this scan.';

  return { findings, invalidCodes, systems, safetyFlags: flags, capabilities, recommendedChecks: checks, missingInformation: missing, summary };
}

const HV_WORDS = /\b(high[- ]?voltage|hv battery|hybrid battery|traction battery|inverter|drive motor|charging port|won'?t charge|not charging|ev battery)\b/i;
const AC_WORDS = /\b(a\/?c|air ?con(ditioning)?|refrigerant|recharge|not blowing cold|blows warm|compressor)\b/i;
const ADAS_WORDS = /\b(windshield|windscreen|adas|lane (keep|assist|departure)|adaptive cruise|radar|front camera|collision (warning|avoidance)|blind[- ]spot|calibrat)/i;
const SRS_WORDS = /\b(airbag|air bag|srs|seat ?belt pretensioner)\b/i;
const MODULE_WORDS = /\b(program(ming)?|reflash|software update|module replacement|key (fob )?programming|immobili[sz]er)\b/i;

/**
 * Which credentials a job is likely to need (MACRE), from the vehicle, the customer's words and
 * any recorded codes. These are suggestions for a person to confirm, never registered
 * automatically. Only legal or high-voltage safety needs are proposed as mandatory.
 */
export function suggestQualificationRequirements(input: {
  powertrain?: string | null;
  symptoms?: string | null;
  dtcCodes?: unknown;
}): QualificationSuggestion[] {
  const out: QualificationSuggestion[] = [];
  const add = (s: QualificationSuggestion) => {
    const existing = out.find((x) => x.requirementKey === s.requirementKey);
    if (!existing) { out.push(s); return; }
    existing.mandatory = existing.mandatory || s.mandatory;
    for (const e of s.evidence) if (!existing.evidence.includes(e)) existing.evidence.push(e);
  };
  const text = String(input.symptoms ?? '');
  const powertrain = String(input.powertrain ?? '').toLowerCase().replace(/_/g, ' ');
  const synthesis = synthesizeObdEvidence({ dtcCodes: input.dtcCodes });
  const hvCodes = synthesis.findings.filter((f) => f.system === 'Hybrid/EV propulsion').map((f) => f.code);
  const electric = /\b(ev|bev|electric|battery[- ]electric)\b/.test(powertrain);
  const hybrid = /\b(hybrid|hev|phev|plug-in)\b/.test(powertrain);
  const hvSymptom = HV_WORDS.exec(text)?.[0];

  if (hvCodes.length || hvSymptom || electric || hybrid) {
    const touchesHv = hvCodes.length > 0 || Boolean(hvSymptom) || electric;
    add({
      requirementKey: 'ev_high_voltage', kind: 'training', label: 'EV high-voltage safety training', mandatory: touchesHv,
      rationale: touchesHv ? 'The job may involve the high-voltage system; working on it untrained is dangerous.'
        : 'Hybrid vehicle; high-voltage training matters if the work reaches the high-voltage system.',
      evidence: [...hvCodes, ...(hvSymptom ? [`symptom: "${hvSymptom}"`] : []), ...(powertrain ? [`powertrain: ${powertrain}`] : [])]
    });
  }
  if (hybrid || (hvCodes.length && !electric)) {
    add({ requirementKey: 'hybrid_systems', kind: 'training', label: 'Hybrid systems training', mandatory: false,
      rationale: 'Hybrid propulsion diagnosis benefits from hybrid-specific training.', evidence: [...hvCodes, ...(hybrid ? [`powertrain: ${powertrain}`] : [])] });
  }
  const ac = AC_WORDS.exec(text)?.[0];
  if (ac) {
    add({ requirementKey: 'ac_refrigerant_609', kind: 'legal_license', label: 'A/C refrigerant handling (EPA 609)', mandatory: true,
      rationale: 'Handling refrigerant legally requires a certified technician (EPA 609 in the US; an ODP card in Ontario).', evidence: [`symptom: "${ac}"`] });
  }
  const adas = ADAS_WORDS.exec(text)?.[0];
  if (adas) {
    add({ requirementKey: 'adas_calibration', kind: 'equipment', label: 'ADAS calibration equipment', mandatory: false,
      rationale: 'Driver-assistance cameras and radar usually need calibrating after this kind of work.', evidence: [`symptom: "${adas}"`] });
  }
  const srsCodes = synthesis.findings.filter((f) => f.system.startsWith('Restraints') || f.code === 'U0151').map((f) => f.code);
  const srs = SRS_WORDS.exec(text)?.[0];
  if (srsCodes.length || srs) {
    add({ requirementKey: 'srs_restraint_systems', kind: 'training', label: 'Airbag/SRS service training', mandatory: false,
      rationale: 'Airbag systems can deploy during service; this needs restraint-system training and the OEM procedure.',
      evidence: [...srsCodes, ...(srs ? [`symptom: "${srs}"`] : [])] });
  }
  const moduleCodes = synthesis.findings.filter((f) => f.domain === 'network' || f.code === 'P0601' || f.code === 'P0606').map((f) => f.code);
  const oemCodes = synthesis.findings.filter((f) => f.manufacturerSpecific).map((f) => f.code);
  const programming = MODULE_WORDS.exec(text)?.[0];
  if (moduleCodes.length || oemCodes.length || programming) {
    add({ requirementKey: 'oem_diagnostic_software', kind: 'manufacturer_access', label: 'OEM diagnostic software access', mandatory: false,
      rationale: 'Module, network or manufacturer-specific faults usually need the manufacturer’s diagnostic software.',
      evidence: [...moduleCodes, ...oemCodes, ...(programming ? [`symptom: "${programming}"`] : [])] });
  }
  const drivability = synthesis.findings.filter((f) => !f.manufacturerSpecific && ['Fuel and air metering', 'Ignition / misfire', 'Emission controls'].includes(f.system)).map((f) => f.code);
  if (drivability.length) {
    add({ requirementKey: 'ase_a8_engine_performance', kind: 'oem_certification', label: 'ASE A8 engine performance', mandatory: false,
      rationale: 'Engine-performance codes are best diagnosed by an engine-performance specialist.', evidence: drivability });
  }
  if (synthesis.findings.some((f) => f.domain === 'network') || synthesis.findings.some((f) => f.code === 'P0562' || f.code === 'P0563')) {
    add({ requirementKey: 'ase_a6_electrical', kind: 'oem_certification', label: 'ASE A6 electrical', mandatory: false,
      rationale: 'Network and voltage faults are electrical diagnosis.',
      evidence: synthesis.findings.filter((f) => f.domain === 'network' || f.code === 'P0562' || f.code === 'P0563').map((f) => f.code) });
  }
  return out;
}
