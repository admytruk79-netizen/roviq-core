import { describe, expect, it } from 'vitest';
import { parseDtc, suggestQualificationRequirements, synthesizeObdEvidence } from './dtc-knowledge.js';

describe('fault-code knowledge', () => {
  it('classifies codes by number range and only defines generic ones', () => {
    expect(parseDtc(' p0302 ')).toEqual({ code: 'P0302', domain: 'powertrain', system: 'Ignition / misfire', manufacturerSpecific: false, description: 'Cylinder 2 misfire detected' });
    expect(parseDtc('P1234')).toMatchObject({ manufacturerSpecific: true, description: null, system: 'Fuel and air metering' });
    expect(parseDtc('P0A80')).toMatchObject({ system: 'Hybrid/EV propulsion', description: 'Replace hybrid battery pack' });
    expect(parseDtc('B0012')).toMatchObject({ domain: 'body', system: 'Restraints (airbags/SRS)' });
    expect(parseDtc('B1012')).toMatchObject({ domain: 'body', system: 'Body systems', manufacturerSpecific: true });
    expect(parseDtc('U0100')?.description).toBe('Lost communication with ECM/PCM A');
    for (const bad of ['', 'P030', 'X0300', 'P03000', 'P4300']) expect(parseDtc(bad)).toBeNull();
  });

  it('turns readings into cited safety flags, checks and services without naming a cause', () => {
    const s = synthesizeObdEvidence({ dtcCodes: ['P0302', 'P0302', 'P0171', 'junk'], signals: { coolantTemperatureC: 118, engineRpm: 700 } });
    expect(s.findings.map((f) => f.code)).toEqual(['P0302', 'P0171']);
    expect(s.invalidCodes).toEqual(['junk']);
    expect(s.safetyFlags.map((f) => [f.code, f.severity, f.evidence])).toEqual([
      ['overheating', 'critical', ['coolantTemperatureC=118']],
      ['misfire', 'warning', ['P0302']]
    ]);
    expect(s.capabilities).toEqual(['diagnostics', 'tow', 'repair']);
    expect(s.recommendedChecks.some((c) => c.includes('fuel trims'))).toBe(true);
    expect(s.summary).toContain('not a confirmed cause');
  });

  it('never calls an empty scan healthy', () => {
    const s = synthesizeObdEvidence({ dtcCodes: [], signals: {} });
    expect(s.safetyFlags).toEqual([]);
    expect(s.capabilities).toEqual(['diagnostics']);
    expect(s.missingInformation[0]).toMatch(/does not show the vehicle is healthy/);
  });

  it('suggests credentials, mandatory only for legal or high-voltage needs', () => {
    const byKey = (list: ReturnType<typeof suggestQualificationRequirements>) => Object.fromEntries(list.map((s) => [s.requirementKey, s.mandatory]));
    expect(byKey(suggestQualificationRequirements({ powertrain: 'plug_in_hybrid', symptoms: 'Oil change' }))).toEqual({ ev_high_voltage: false, hybrid_systems: false });
    expect(byKey(suggestQualificationRequirements({ powertrain: 'hybrid', dtcCodes: ['P0AA6'] }))).toEqual({ ev_high_voltage: true, hybrid_systems: false });
    expect(byKey(suggestQualificationRequirements({ powertrain: 'electric', symptoms: 'tire rotation' }))).toEqual({ ev_high_voltage: true });
    expect(byKey(suggestQualificationRequirements({ symptoms: 'A/C blows warm after windshield replacement' }))).toEqual({ ac_refrigerant_609: true, adas_calibration: false });
    expect(byKey(suggestQualificationRequirements({ dtcCodes: ['B0012', 'U0100', 'P0420'] }))).toEqual({
      srs_restraint_systems: false, oem_diagnostic_software: false, ase_a8_engine_performance: false, ase_a6_electrical: false
    });
    expect(suggestQualificationRequirements({ powertrain: 'gasoline', symptoms: 'brakes squeal' })).toEqual([]);
    const hv = suggestQualificationRequirements({ powertrain: 'hybrid', dtcCodes: ['P0A80'] })[0]!;
    expect(hv.evidence).toEqual(['P0A80', 'powertrain: hybrid']);
  });
});
