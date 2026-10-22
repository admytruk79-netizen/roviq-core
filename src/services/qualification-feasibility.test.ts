import { describe, expect, it } from 'vitest';
import { evaluateQualification, type Requirement, type Evidence } from './qualification-feasibility.js';
const at = new Date('2026-10-22T12:00:00Z');
const required: Requirement[] = [{ id: 'hv-qualified', kind: 'training', mandatory: true, scope: 'model-x/high-voltage' }];
const verified: Evidence[] = [{ requirementId: 'hv-qualified', status: 'verified', scope: 'model-x/high-voltage', validUntil: '2027-01-01T00:00:00Z' }];
describe('MACRE qualification feasibility', () => {
  it('accepts qualifying verified evidence', () => expect(evaluateQualification(required, verified, at).decision).toBe('eligible'));
  it('fails closed when mandatory evidence is absent', () => expect(evaluateQualification(required, [], at).decision).toBe('blocked'));
  it('rejects other vehicle scopes', () => expect(evaluateQualification(required, [{ ...verified[0]!, scope: 'model-y/high-voltage' }], at).results[0]?.reason).toBe('scope_mismatch'));
  it('rejects expired credentials', () => expect(evaluateQualification(required, [{ ...verified[0]!, validUntil: '2026-01-01T00:00:00Z' }], at).decision).toBe('blocked'));
  it('rejects revoked credentials', () => expect(evaluateQualification(required, [{ ...verified[0]!, status: 'revoked' }], at).decision).toBe('blocked'));
  it('rejects malformed expirations', () => expect(evaluateQualification(required, [{ ...verified[0]!, validUntil: 'garbage' }], at).decision).toBe('blocked'));
  it('requests review on missing optional constraints', () => expect(evaluateQualification([{ id: 'loaner', kind: 'capacity', mandatory: false }], [], at).decision).toBe('review_required'));
  it('allows empty requirements', () => expect(evaluateQualification([], [], at).decision).toBe('eligible'));
  it('rejects duplicate IDs', () => expect(() => evaluateQualification([...required, ...required], verified, at)).toThrow('duplicate_or_empty_requirement_id'));
  it('satisfies a requirement if any evidence is valid', () => expect(evaluateQualification(required, [{ ...verified[0]!, status: 'expired' }, ...verified], at).decision).toBe('eligible'));
});
