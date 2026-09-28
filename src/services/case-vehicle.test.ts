import { describe, expect, it } from 'vitest';
import { projectVehicle, vinSchema, type VehicleRow } from './case-vehicle.js';

const row: VehicleRow = {
  id: 'v1', customer_actor_id: 'c1', vin: '1HGCM82633A004352', year: 2019, make: 'Honda', model: 'Accord', trim: 'EX',
  nickname: 'Daily', color: 'Blue', license_plate: 'ABC123', plate_region: 'OR', drivetrain: 'fwd', fuel_type: 'gasoline',
  engine: '1.5L I4', odometer_value: 84000, odometer_unit: 'miles', verified_at: '2026-09-28T00:00:00Z',
  verified_by_actor_id: 'd1', archived_at: null, created_at: '', updated_at: ''
};

describe('case vehicle projection', () => {
  it('gives the customer, shop, diagnostic and admin the full record', () => {
    for (const role of ['customer', 'partner', 'diagnostic', 'admin'] as const) {
      expect(projectVehicle(role, row)).toMatchObject({ vin: row.vin, odometerValue: 84000, licensePlate: 'ABC123', verified: true });
    }
  });

  it('gives tow what it needs to find and load the vehicle, without VIN, odometer or owner nickname', () => {
    const tow = projectVehicle('tow', row)!;
    expect(Object.keys(tow).sort()).toEqual(['color', 'drivetrain', 'fuelType', 'id', 'licensePlate', 'make', 'model', 'plateRegion', 'trim', 'verified', 'year']);
  });

  it('gives parts what it needs for fitment, without plate, color, odometer or nickname', () => {
    const parts = projectVehicle('parts', row)!;
    expect(Object.keys(parts).sort()).toEqual(['drivetrain', 'engine', 'fuelType', 'id', 'make', 'model', 'trim', 'verified', 'vin', 'year']);
  });

  it('gives mobility nothing, and handles a case without a vehicle', () => {
    expect(projectVehicle('fleet', row)).toBeNull();
    expect(projectVehicle('tow', null)).toBeNull();
  });
});

describe('VIN validation', () => {
  it('normalizes case, spaces and dashes', () => {
    expect(vinSchema.parse(' 1hgcm-82633a 004352 ')).toBe('1HGCM82633A004352');
  });

  it('rejects the wrong length and the letters I, O and Q', () => {
    for (const bad of ['1HGCM82633A00435', '1HGCM82633A0043521', '1HGCM82633AI04352', '1HGCM82633AO04352', '1HGCM82633AQ04352']) {
      expect(vinSchema.safeParse(bad).success).toBe(false);
    }
  });
});
