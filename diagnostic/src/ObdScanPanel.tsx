import { useEffect, useRef, useState } from 'react';
import { createObdBridgeClient, type NativeBridge } from '../../cloudflare/obd-bridge-client.js';
import { createHealthEvent, uploadAndAnalyzeScan, type Scan, type ScanContext } from '../../cloudflare/obd-scan.js';
import {scanOutbox} from '../../cloudflare/obd-outbox.js';

type Enrollment = {enrollment_id: string; source_id: string; vehicle_id: string; provider_key: string; scanner_device_id: string};
type Device = {address: string; name: string};
const API = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');
const TOKEN = 'roviq_diagnostic_token';
const ERRORS: Record<string,string> = {
  bluetooth_permission_required: 'Allow nearby-device access, then refresh scanners.',
  scanner_not_paired: 'Pair the OBDLink scanner in Android Bluetooth settings first.',
  scanner_read_failed: 'Could not read the scanner. Check Bluetooth, ignition and vehicle compatibility.',
  scan_cancelled: 'Scan cancelled.', scanner_cancelled: 'Scan cancelled.',
  scanner_timeout: 'Scanner timed out. Check the connection and retry.'
};

export function ObdScanPanel({caseId}: {caseId: string}) {
  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [enrollmentId, setEnrollmentId] = useState('');
  const [address, setAddress] = useState('');
  const [snapshot, setSnapshot] = useState<Scan|null>(null);
  const [scanContext, setScanContext] = useState<ScanContext|null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [analysis, setAnalysis] = useState<Awaited<ReturnType<typeof uploadAndAnalyzeScan>>|null>(null);
  const client = useRef<ReturnType<typeof createObdBridgeClient>|null>(null);
  const live = useRef(true);
  const bridge = (window as unknown as {ROVIQObd?: NativeBridge}).ROVIQObd;
  const available = Boolean(bridge) && window.top === window.self;
  useEffect(() => {
    live.current = true;
    if (bridge && available) client.current = createObdBridgeClient(bridge);
    let active = true;
    void scanOutbox.restore(localStorage.getItem(TOKEN) ?? '', caseId).then(saved => {
      if (!active || !saved) return;
      setSnapshot(saved.scan); setScanContext(saved.context); setConfirmed(false);
      setNotice('Recovered a pending scan from this account. Verify the vehicle before retrying upload or analysis.');
    }).catch(() => {});
    return () => { active = false; live.current = false; client.current?.dispose(); client.current = null; };
  }, [bridge, available, caseId]);

  async function refresh() {
    if (!client.current) return;
    setBusy(true); setError(''); setSnapshot(null); setAnalysis(null); setConfirmed(false);
    try {
      const res = await fetch(`${API}/api/maintenance/cases/${caseId}/obd-enrollments`, {headers: {authorization: `Bearer ${localStorage.getItem(TOKEN) ?? ''}`}, signal: AbortSignal.timeout(10000)});
      if (!res.ok) throw new Error('scan_access_unavailable');
      const body = await res.json() as {enrollments: Enrollment[]};
      const result = await client.current.request('list') as {devices: Device[]};
      if (!live.current) return;
      setEnrollments(body.enrollments); setEnrollmentId(body.enrollments[0]?.enrollment_id ?? '');
      setDevices(result.devices); setAddress(result.devices[0]?.address ?? '');
    } catch (e) { if (live.current) setError(ERRORS[e instanceof Error ? e.message : ''] ?? 'Could not load scanner access. Confirm vehicle enrollment, consent and your case assignment.'); }
    finally { if (live.current) setBusy(false); }
  }
  async function read() {
    const enrollment = enrollments.find(e => e.enrollment_id === enrollmentId);
    if (!client.current || !enrollment) return;
    if(enrollment.scanner_device_id.toUpperCase()!==address.toUpperCase()) {setError('This scanner is not enrolled for the case vehicle. Ask the customer to enroll and consent to this scanner first.');return;}
    setBusy(true); setError(''); setSnapshot(null); setAnalysis(null); setConfirmed(false);
    try {
      const result = await client.current.request('scan', address) as {snapshot: Scan};
      const context = {vehicleId: enrollment.vehicle_id, sourceId: enrollment.source_id, enrollmentId, serviceCaseId: caseId};
      createHealthEvent(context, result.snapshot); // Strict parsing before exposing/uploading data.
      if (live.current) { setSnapshot(result.snapshot); setScanContext(context); setNotice('Scan captured. Verify the vehicle and readings before upload.'); }
    } catch (e) { if (live.current) setError(ERRORS[e instanceof Error ? e.message : ''] ?? 'Unsupported or incomplete scan. No vehicle data was uploaded.'); }
    finally { if (live.current) setBusy(false); }
  }
  async function upload() {
    if (!snapshot || !scanContext || !confirmed) return;
    const token = localStorage.getItem(TOKEN) ?? '';
    setBusy(true); setError('');
    try {
      await scanOutbox.save(token, scanContext, snapshot);
      const result = await uploadAndAnalyzeScan({token, context: scanContext, scan: snapshot, apiBase: API});
      if (!result.analysisPending) await scanOutbox.remove(token, snapshot.scanId);
      if (live.current) { setAnalysis(result); setNotice(result.analysisState === 'blocked' ? 'Scan saved, but analysis was blocked because access or consent changed.' : result.analysisState === 'reviewed' ? 'Scan saved. The assessment has already been reviewed.' : result.analysisPending ? 'Scan saved. Analysis is queued for retry; original readings are preserved.' : result.analysis?.modelStatus === 'fallback' ? 'Scan saved. Cloud AI was unavailable; a fallback review assessment was recorded.' : 'Scan saved and cloud analysis returned. Review the assessment before recording a finding.'); }
    } catch { if (live.current) setError('Upload rejected or unavailable. This scan stays on screen for retry; check access and consent.'); }
    finally { if (live.current) setBusy(false); }
  }
  if (!available) return <section className="panel form"><h3>Read OBD scanner</h3><p>Open this case in the Android app’s standalone diagnostic workspace to connect a paired OBDLink scanner. Browser and embedded workspace scanning are unavailable.</p></section>;
  const event = snapshot && scanContext ? createHealthEvent(scanContext, snapshot) : null;
  return <section className="panel form" aria-label="OBD vehicle scan"><h3>Read OBD scanner</h3>
    <p className="hint">Park safely and pair your OBDLink scanner in Android settings. Confirm the selected vehicle and active customer consent. This scan reads codes and measurements; it clears nothing.</p>
    <button type="button" className="secondary" disabled={busy} onClick={() => void refresh()}>Refresh scanners and access</button>
    {devices.length > 0 && <label>Paired scanner<select disabled={busy} value={address} onChange={e => {setAddress(e.target.value); setSnapshot(null);}}>{devices.map(d => <option key={d.address} value={d.address}>{d.name}</option>)}</select></label>}
    {enrollments.length > 0 && <label>Consented vehicle connection<select disabled={busy} value={enrollmentId} onChange={e => {setEnrollmentId(e.target.value); setSnapshot(null);}}>{enrollments.map(e => <option key={e.enrollment_id} value={e.enrollment_id}>{e.provider_key}</option>)}</select></label>}
    <div className="actions"><button type="button" className="secondary" disabled={busy || !address || !enrollmentId} onClick={() => void read()}>Read scanner</button>{busy && <button type="button" className="secondary" onClick={() => client.current?.cancel()}>Cancel scanner</button>}</div>
    {event && <><p>Reported codes: {event.dtcCodes.join(', ') || 'None reported — this does not establish vehicle health'}</p><pre>{JSON.stringify(event.normalizedSignals, null, 2)}</pre>
      <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)}/>I verified this scanner is connected to the vehicle on this case.</label>
      <button type="button" className="secondary" disabled={busy || !confirmed || Boolean(analysis && !analysis.analysisPending)} onClick={() => void upload()}>{analysis?.analysisPending ? 'Refresh queued analysis' : 'Upload and analyze scan'}</button></>}
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
    {analysis?.analysis && <div><h4>{analysis.analysis.modelStatus === 'ai' ? 'Cloud AI assessment — requires review' : 'Fallback assessment — cloud AI unavailable'}</h4><p>{analysis.analysis.summary}</p>{analysis.analysis.possibleCauses.map((item, i) => <p key={i}>Possible cause, unconfirmed: {item.cause}</p>)}{analysis.analysis.recommendedChecks.map((item, i) => <p key={i}>Suggested check: {item}</p>)}{analysis.analysis.missingInformation.map((item, i) => <p key={i}>Missing information: {item}</p>)}</div>}
  </section>;
}
