import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { CustomerVehicle } from '../lib/types';

export type NewVehicleInput = {
  year: number; make: string; model: string; color?: string; licensePlate?: string; vin?: string;
  fuelType?: string; drivetrain?: string;
};
/** Either one of the customer's saved vehicles, or a new vehicle to save with the request. */
export type VehicleChoice = { vehicleId: string } | { vehicle: NewVehicleInput } | null;

const inputClass = 'mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none';
const labelClass = 'block text-sm font-medium text-slate-700';
const ADD = '__add__';

export function vehicleLabel(v: Pick<CustomerVehicle, 'year' | 'make' | 'model' | 'nickname' | 'color'>) {
  const name = [v.year, v.make, v.model].filter(Boolean).join(' ');
  return [v.nickname || name, v.nickname ? name : v.color].filter(Boolean).join(' · ');
}

export function VehiclePicker({ onChange }: { onChange: (choice: VehicleChoice) => void }) {
  const [vehicles, setVehicles] = useState<CustomerVehicle[] | null>(null);
  const [selected, setSelected] = useState('');
  const [year, setYear] = useState('');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [color, setColor] = useState('');
  const [plate, setPlate] = useState('');
  const [vin, setVin] = useState('');
  const [fuelType, setFuelType] = useState('');
  const [drivetrain, setDrivetrain] = useState('');

  useEffect(() => {
    api.get<{ vehicles: CustomerVehicle[] }>('/api/me/vehicles')
      .then((r) => {
        setVehicles(r.vehicles);
        setSelected(r.vehicles.length ? r.vehicles[0].id : ADD);
      })
      .catch(() => { setVehicles([]); setSelected(ADD); });
  }, []);

  useEffect(() => {
    if (!selected) return onChange(null);
    if (selected !== ADD) return onChange({ vehicleId: selected });
    const y = Number(year);
    if (!Number.isInteger(y) || !make.trim() || !model.trim()) return onChange(null);
    onChange({
      vehicle: {
        year: y, make: make.trim(), model: model.trim(),
        ...(color.trim() ? { color: color.trim() } : {}),
        ...(plate.trim() ? { licensePlate: plate.trim() } : {}),
        ...(vin.trim() ? { vin: vin.trim() } : {}),
        ...(fuelType ? { fuelType } : {}),
        ...(drivetrain ? { drivetrain } : {})
      }
    });
    // onChange is the parent's stable state setter, so it is not a dependency.
  }, [selected, year, make, model, color, plate, vin, fuelType, drivetrain]);

  if (vehicles === null) return <p className="text-sm text-slate-500">Loading your vehicles…</p>;

  const adding = selected === ADD;
  const maxYear = new Date().getFullYear() + 2;

  return (
    <fieldset className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <legend className="px-1 text-sm font-medium text-slate-700">Which vehicle?</legend>
      {vehicles.length > 0 && (
        <div className="space-y-2">
          {vehicles.map((v) => (
            <label key={v.id} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm">
              <input type="radio" name="vehicle" value={v.id} checked={selected === v.id} onChange={() => setSelected(v.id)} />
              <span>
                <span className="font-medium text-slate-800">{vehicleLabel(v)}</span>
                {v.licensePlate && <span className="ml-2 text-xs text-slate-500">{v.licensePlate}</span>}
              </span>
            </label>
          ))}
          <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-dashed border-slate-300 bg-white px-3 py-2 text-sm">
            <input type="radio" name="vehicle" value={ADD} checked={adding} onChange={() => setSelected(ADD)} />
            <span className="font-medium text-slate-700">A different vehicle</span>
          </label>
        </div>
      )}
      {adding && (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className={labelClass} htmlFor="vehicleYear">Year</label>
              <input id="vehicleYear" required inputMode="numeric" type="number" min={1950} max={maxYear} value={year} onChange={(e) => setYear(e.target.value)} className={inputClass} />
            </div>
            <div>
              <label className={labelClass} htmlFor="vehicleMake">Make</label>
              <input id="vehicleMake" required value={make} onChange={(e) => setMake(e.target.value)} placeholder="Toyota" className={inputClass} />
            </div>
            <div>
              <label className={labelClass} htmlFor="vehicleModel">Model</label>
              <input id="vehicleModel" required value={model} onChange={(e) => setModel(e.target.value)} placeholder="Camry" className={inputClass} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={labelClass} htmlFor="vehicleColor">Color <span className="font-normal text-slate-400">(helps the driver find it)</span></label>
              <input id="vehicleColor" value={color} onChange={(e) => setColor(e.target.value)} placeholder="Silver" className={inputClass} />
            </div>
            <div>
              <label className={labelClass} htmlFor="vehiclePlate">License plate</label>
              <input id="vehiclePlate" value={plate} onChange={(e) => setPlate(e.target.value)} autoCapitalize="characters" className={inputClass} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={labelClass} htmlFor="vehicleFuel">Fuel</label>
              <select id="vehicleFuel" value={fuelType} onChange={(e) => setFuelType(e.target.value)} className={inputClass}>
                <option value="">Not sure</option>
                <option value="gasoline">Gas</option>
                <option value="diesel">Diesel</option>
                <option value="hybrid">Hybrid</option>
                <option value="plug_in_hybrid">Plug-in hybrid</option>
                <option value="electric">Electric</option>
              </select>
            </div>
            <div>
              <label className={labelClass} htmlFor="vehicleDrive">Drive</label>
              <select id="vehicleDrive" value={drivetrain} onChange={(e) => setDrivetrain(e.target.value)} className={inputClass}>
                <option value="">Not sure</option>
                <option value="fwd">Front-wheel</option>
                <option value="rwd">Rear-wheel</option>
                <option value="awd">All-wheel</option>
                <option value="4wd">4×4</option>
              </select>
            </div>
          </div>
          <div>
            <label className={labelClass} htmlFor="vehicleVin">VIN <span className="font-normal text-slate-400">(optional, 17 characters)</span></label>
            <input id="vehicleVin" value={vin} onChange={(e) => setVin(e.target.value)} maxLength={20} autoCapitalize="characters" spellCheck={false} className={`${inputClass} font-mono`} />
            <p className="mt-1 text-xs text-slate-500">On the dashboard by the windshield, the driver's door frame, or your registration. The technician can add it on site.</p>
          </div>
          <p className="text-xs text-slate-500">We'll save this vehicle so you can pick it next time.</p>
        </div>
      )}
    </fieldset>
  );
}
