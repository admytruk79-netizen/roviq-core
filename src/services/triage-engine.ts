import { performance } from 'node:perf_hooks';
import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { createTriageAssessment } from './triage.js';

export type TriageMode = 'shadow'|'advisory'|'assisted';

type TriageResult = {
  symptomSummary:string;
  suggestedCapabilities:string[];
  suggestedDrivability:'unknown'|'drivable'|'limited'|'non_drivable';
  safetyFlags:Array<{ code:string; severity:'info'|'warning'|'critical'; rationale:string }>;
  evidence:Array<{ source:string; statement:string }>;
  confidence:number;
  missingInformation:string[];
  suggestedActions:Array<{ actionType:string; actionPayload?:Record<string,unknown> }>;
};

const ENGINE_VERSION = 'triage-0.1.0';

export async function runTriage(principal:Principal, input:{
  caseId:string;
  symptoms:string;
  vehicle?:Record<string,unknown>;
  observations?:Record<string,unknown>;
  mode?:TriageMode;
}) {
  const mode = input.mode ?? (process.env.TRIAGE_DEPLOYMENT_MODE as TriageMode | undefined) ?? 'shadow';
  const safety = deterministicSafety(input.symptoms,input.observations ?? {});
  const started = performance.now();
  const model = await inferStructured({ symptoms:input.symptoms, vehicle:input.vehicle ?? {}, observations:input.observations ?? {} });
  const latencyMs = Math.round(performance.now()-started);

  let result:TriageResult = model;
  let safetyOverride = false;
  let safetyOverrideReason:string|undefined;

  if (safety.forceNonDrivable) {
    safetyOverride = true;
    safetyOverrideReason = safety.reason;
    result = {
      ...model,
      suggestedDrivability:'non_drivable',
      safetyFlags:mergeSafetyFlags(model.safetyFlags,safety.flags),
      suggestedCapabilities:Array.from(new Set([...model.suggestedCapabilities,'diagnostics','tow']))
    };
  } else {
    result = { ...model, safetyFlags:mergeSafetyFlags(model.safetyFlags,safety.flags) };
  }

  const requiresHumanReview = safetyOverride || result.confidence < Number(process.env.TRIAGE_AUTO_CONFIDENCE_THRESHOLD ?? 0.90) || result.safetyFlags.some(x=>x.severity==='critical');

  const assessment = await createTriageAssessment(principal,{
    caseId:input.caseId,
    source:'ai_engine',
    modelProvider:process.env.TRIAGE_MODEL_PROVIDER ?? 'openai-compatible',
    modelName:process.env.TRIAGE_MODEL ?? 'configured-model',
    inputSnapshot:{ symptoms:input.symptoms, vehicle:input.vehicle ?? {}, observations:input.observations ?? {} },
    symptomSummary:result.symptomSummary,
    suggestedCapabilities:result.suggestedCapabilities,
    suggestedDrivability:result.suggestedDrivability,
    safetyFlags:result.safetyFlags,
    evidence:result.evidence,
    confidence:result.confidence,
    requiresHumanReview,
    actions:result.suggestedActions
  });

  await pool.query(
    `update ai_triage_assessments set engine_version=$1,deployment_mode=$2,safety_override=$3,safety_override_reason=$4,raw_model_output=$5,latency_ms=$6 where id=$7`,
    [ENGINE_VERSION,mode,safetyOverride,safetyOverrideReason ?? null,JSON.stringify(model),latencyMs,assessment.id]
  );

  return { assessmentId:assessment.id, engineVersion:ENGINE_VERSION, mode, safetyOverride, requiresHumanReview, result };
}

const TRIAGE_JSON_SHAPE = `{
  "symptomSummary": string,
  "suggestedCapabilities": string[],
  "suggestedDrivability": "unknown" | "drivable" | "limited" | "non_drivable",
  "safetyFlags": Array<{ "code": string, "severity": "info" | "warning" | "critical", "rationale": string }>,
  "evidence": Array<{ "source": string, "statement": string }>,
  "confidence": number between 0 and 1,
  "missingInformation": string[],
  "suggestedActions": Array<{ "actionType": string, "actionPayload"?: object }>
}`;

async function inferStructured(input:{ symptoms:string; vehicle:Record<string,unknown>; observations:Record<string,unknown> }):Promise<TriageResult> {
  const endpoint = process.env.TRIAGE_MODEL_ENDPOINT;
  const apiKey = process.env.TRIAGE_MODEL_API_KEY;
  const model = process.env.TRIAGE_MODEL;
  if (!endpoint || !apiKey || !model) {
    console.error('roviq_triage_fallback', { reason:'model_not_configured' });
    return conservativeFallback(input);
  }

  let response: Response;
  try {
    response = await fetch(endpoint,{
      method:'POST',
      headers:{ 'authorization':`Bearer ${apiKey}`,'content-type':'application/json', ...(process.env.TRIAGE_GATEWAY_ID ? {'cf-aig-gateway-id':process.env.TRIAGE_GATEWAY_ID} : {}) },
      body:JSON.stringify({
        model,
        temperature:0,
        messages:[
          { role:'system', content:`You are ROVIQ automotive triage. Be conservative. Do not name or select providers. Do not claim a definitive diagnosis. Identify safety risks, drivability, missing information, and which service capabilities may be needed. Respond with ONLY a single JSON object matching exactly this shape, no prose, no markdown fences:\n${TRIAGE_JSON_SHAPE}` },
          { role:'user', content:JSON.stringify(input) }
        ]
      })
    });
  } catch (error) {
    console.error('roviq_triage_fallback', { reason:'request_failed', error:error instanceof Error ? error.message : String(error) });
    return conservativeFallback(input);
  }
  if (!response.ok) {
    console.error('roviq_triage_fallback', { reason:'non_ok_response', status:response.status, body:await response.text().catch(()=>'') });
    return conservativeFallback(input);
  }
  try {
    const json:any = await response.json();
    const candidate = json?.response ?? json?.choices?.[0]?.message?.content ?? json;
    const text = typeof candidate === 'string' ? candidate.trim().replace(/^```(?:json)?\s*|\s*```$/g,'') : candidate;
    const parsed = typeof text === 'string' ? JSON.parse(text) : text;
    return validateResult(parsed,input);
  } catch (error) {
    console.error('roviq_triage_fallback', { reason:'parse_failed', error:error instanceof Error ? error.message : String(error) });
    return conservativeFallback(input);
  }
}

function validateResult(x:any,input:any):TriageResult {
  if (!x || typeof x !== 'object') return conservativeFallback(input);
  const confidence = Number(x.confidence);
  return {
    symptomSummary:String(x.symptomSummary ?? input.symptoms).slice(0,1000),
    suggestedCapabilities:Array.isArray(x.suggestedCapabilities)?x.suggestedCapabilities.map(String).slice(0,8):['diagnostics'],
    suggestedDrivability:['unknown','drivable','limited','non_drivable'].includes(x.suggestedDrivability)?x.suggestedDrivability:'unknown',
    safetyFlags:Array.isArray(x.safetyFlags)?x.safetyFlags.slice(0,12):[],
    evidence:Array.isArray(x.evidence)?x.evidence.slice(0,12):[],
    confidence:Number.isFinite(confidence)?Math.min(1,Math.max(0,confidence)):0.3,
    missingInformation:Array.isArray(x.missingInformation)?x.missingInformation.map(String).slice(0,12):[],
    suggestedActions:Array.isArray(x.suggestedActions)?x.suggestedActions.slice(0,8):[]
  } as TriageResult;
}

function conservativeFallback(input:any):TriageResult {
  return {
    symptomSummary:String(input.symptoms ?? 'Vehicle concern reported'),
    suggestedCapabilities:['diagnostics'],
    suggestedDrivability:'unknown',
    safetyFlags:[], evidence:[], confidence:0.2,
    missingInformation:['Professional diagnostic assessment required'],
    suggestedActions:[{actionType:'request_diagnostic_review'}]
  };
}

function deterministicSafety(symptoms:string, observations:Record<string,unknown>) {
  const text = `${symptoms} ${JSON.stringify(observations)}`.toLowerCase();
  const patterns = [
    ['fire_or_smoke',/\b(fire|flames|smoke from engine|burning smell)\b/],
    ['fuel_leak',/\b(fuel leak|gasoline leak|strong fuel smell|smells like gas)\b/],
    ['brake_failure',/\b(no brakes|brake failure|brake pedal.*floor)\b/],
    ['steering_failure',/\b(steering locked|cannot steer|steering failure)\b/],
    ['oil_pressure',/\b(oil pressure warning|low oil pressure)\b/],
    ['overheating',/\b(overheating|temperature gauge.*red|coolant.*boiling)\b/],
    ['ev_high_voltage',/\b(high voltage warning|battery fire|thermal runaway)\b/],
    ['severe_misfire',/\b(flashing check engine|engine.*shaking violently|severe misfire)\b/]
  ] as const;
  const matches = patterns.filter(([,re])=>re.test(text)).map(([code])=>({code,severity:'critical' as const,rationale:'Deterministic safety rule matched reported symptoms.'}));
  return { forceNonDrivable:matches.length>0, reason:matches.map(x=>x.code).join(','), flags:matches };
}

function mergeSafetyFlags(a:TriageResult['safetyFlags'],b:TriageResult['safetyFlags']) {
  const seen = new Set<string>();
  return [...b,...a].filter(x=>{const k=`${x.code}:${x.severity}`;if(seen.has(k))return false;seen.add(k);return true;});
}
