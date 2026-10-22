// Shared vocabulary for case requirements and technician credentials (MACRE).
export const QUALIFICATION_KINDS = [
  ['legal_license', 'Legal licence'],
  ['oem_certification', 'OEM certification'],
  ['manufacturer_access', 'Manufacturer access'],
  ['training', 'Training'],
  ['equipment', 'Equipment'],
  ['facility', 'Facility'],
  ['parts', 'Parts'],
  ['capacity', 'Capacity'],
  ['authorization', 'Authorization']
] as const;
export type QualificationKind = (typeof QUALIFICATION_KINDS)[number][0];
export const kindLabel = (kind: string) => QUALIFICATION_KINDS.find(([k]) => k === kind)?.[1] ?? kind;

// Common requirements, so Ops and credential records use the same keys.
export const QUALIFICATION_PRESETS: { key: string; kind: QualificationKind; label: string }[] = [
  { key: 'ev_high_voltage', kind: 'training', label: 'EV high-voltage safety training' },
  { key: 'hybrid_systems', kind: 'training', label: 'Hybrid systems training' },
  { key: 'ase_a6_electrical', kind: 'oem_certification', label: 'ASE A6 electrical' },
  { key: 'ase_a8_engine_performance', kind: 'oem_certification', label: 'ASE A8 engine performance' },
  { key: 'ase_l1_advanced_engine', kind: 'oem_certification', label: 'ASE L1 advanced engine performance' },
  { key: 'diesel_heavy_duty', kind: 'training', label: 'Heavy-duty diesel' },
  { key: 'oem_diagnostic_software', kind: 'manufacturer_access', label: 'OEM diagnostic software access' },
  { key: 'adas_calibration', kind: 'equipment', label: 'ADAS calibration equipment' },
  { key: 'ac_refrigerant_609', kind: 'legal_license', label: 'A/C refrigerant handling (EPA 609)' },
  { key: 'heavy_tow_class_c', kind: 'legal_license', label: 'Heavy tow licence' }
];
