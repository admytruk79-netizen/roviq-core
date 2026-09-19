import { describe, expect, it } from 'vitest';

function enrollmentIdentityError(externalDeviceId: unknown) {
  return externalDeviceId === undefined ? 'external_device_id_required' : null;
}

function consentScopeError(scopes: unknown) {
  return Array.isArray(scopes) && scopes.includes('vehicle_health') ? null : 'vehicle_health_scope_required';
}

describe('connected vehicle enrollment and consent invariants', () => {
  it('requires a stable external device id so enrollment upsert cannot bypass uniqueness with NULL', () => {
    expect(enrollmentIdentityError(undefined)).toBe('external_device_id_required');
    expect(enrollmentIdentityError('reader-123')).toBeNull();
  });

  it('requires vehicle_health consent before connected telemetry ingestion', () => {
    expect(consentScopeError(['location'])).toBe('vehicle_health_scope_required');
    expect(consentScopeError([])).toBe('vehicle_health_scope_required');
    expect(consentScopeError(['vehicle_health'])).toBeNull();
  });
});
