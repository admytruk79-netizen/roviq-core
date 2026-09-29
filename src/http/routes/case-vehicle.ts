import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { audit } from '../../services/audit.js';
import { loadCaseForPrincipal } from '../../services/case-access.js';
import { appendCaseEvent } from '../../services/orchestration.js';
import {
  createCustomerVehicle, listCustomerVehicles, loadCaseVehicle, loadOwnedVehicle, newVehicleSchema, projectVehicle,
  updateVehicle, vehicleForCustomer, vehicleUpdateSchema, VehicleError, type VehicleRow
} from '../../services/case-vehicle.js';
import { requireRole } from '../middleware/principal.js';

function sendVehicleError(reply: FastifyReply, error: unknown) {
  if (error instanceof VehicleError) return reply.code(error.status).send({ error: error.code });
  if (error instanceof Error && error.message === 'forbidden') return reply.code(403).send({ error: 'forbidden' });
  throw error;
}

export async function caseVehicleRoutes(app: FastifyInstance) {
  // The customer's garage: saved vehicles reused on every new case.
  app.get('/api/me/vehicles', { preHandler: requireRole('customer') }, async (req) => {
    const vehicles = await listCustomerVehicles(req.principal.actorId!);
    return { vehicles: vehicles.map(vehicleForCustomer) };
  });

  app.post('/api/me/vehicles', { preHandler: requireRole('customer') }, async (req, reply) => {
    const body = newVehicleSchema.parse(req.body);
    try {
      const vehicle = await createCustomerVehicle(req.principal.actorId!, body);
      await audit(req.principal, 'create_vehicle', 'customer_vehicle', vehicle.id, 'customer_garage');
      return reply.code(201).send({ vehicle: vehicleForCustomer(vehicle) });
    } catch (error) { return sendVehicleError(reply, error); }
  });

  app.patch('/api/me/vehicles/:vehicleId', { preHandler: requireRole('customer') }, async (req, reply) => {
    const { vehicleId } = req.params as { vehicleId: string };
    const body = vehicleUpdateSchema.parse(req.body);
    try {
      await loadOwnedVehicle(req.principal.actorId!, vehicleId);
      const vehicle = await updateVehicle(vehicleId, body);
      await audit(req.principal, 'update_vehicle', 'customer_vehicle', vehicleId, 'customer_garage', { fields: Object.keys(body) });
      return { vehicle: vehicleForCustomer(vehicle) };
    } catch (error) { return sendVehicleError(reply, error); }
  });

  // Removing a vehicle hides it from the garage; cases, repair orders and history keep their link.
  app.delete('/api/me/vehicles/:vehicleId', { preHandler: requireRole('customer') }, async (req, reply) => {
    const { vehicleId } = req.params as { vehicleId: string };
    try {
      await loadOwnedVehicle(req.principal.actorId!, vehicleId);
      await pool.query('update customer_vehicles set archived_at=now(),updated_at=now() where id=$1', [vehicleId]);
      await audit(req.principal, 'archive_vehicle', 'customer_vehicle', vehicleId, 'customer_garage');
      return { archived: true };
    } catch (error) { return sendVehicleError(reply, error); }
  });

  // The case vehicle, reduced to what the caller's role needs.
  app.get('/api/maintenance/cases/:id/vehicle', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const c = await loadCaseForPrincipal(req.principal, id);
      if (!c) return reply.code(404).send({ error: 'case_not_found' });
      return { vehicle: projectVehicle(req.principal.role, await loadCaseVehicle(id)) };
    } catch (error) { return sendVehicleError(reply, error); }
  });

  // The customer chooses (or changes) the vehicle until someone on site has confirmed it.
  app.put('/api/maintenance/cases/:id/vehicle', { preHandler: requireRole('customer', 'admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { vehicleId } = z.object({ vehicleId: z.string().uuid() }).parse(req.body);
    const client = await pool.connect();
    try {
      await client.query('begin');
      const c = await loadCaseForPrincipal(req.principal, id, client);
      if (!c) throw new VehicleError('case_not_found', 404);
      await client.query('select 1 from service_cases where id=$1 for update', [id]);
      const customerActorId = c.customer_actor_id as string | null;
      if (!customerActorId) throw new VehicleError('case_has_no_customer', 409);
      const vehicle = await loadOwnedVehicle(customerActorId, vehicleId, client);
      const current = await loadCaseVehicle(id, client);
      if (current && current.id !== vehicle.id && current.verified_at) throw new VehicleError('case_vehicle_confirmed', 409);
      await client.query('update service_cases set vehicle_id=$2,updated_at=now() where id=$1', [id, vehicle.id]);
      await client.query('commit');
      await appendCaseEvent(id, 'CASE_VEHICLE_SET', req.principal, { vehicleId: vehicle.id, previousVehicleId: current?.id ?? null })
        .catch((e) => console.warn('case_vehicle_event_failed', { caseId: id, error: e instanceof Error ? e.message : e }));
      return { vehicle: projectVehicle(req.principal.role, vehicle) };
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      return sendVehicleError(reply, error);
    } finally {
      client.release();
    }
  });

  // The diagnostic technician or shop confirms the vehicle in front of them: corrects details,
  // records VIN and odometer, and marks it verified. With no vehicle on the case yet, this
  // creates one for the case's customer.
  app.post('/api/maintenance/cases/:id/vehicle/confirm', { preHandler: requireRole('diagnostic', 'partner', 'admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = vehicleUpdateSchema.parse(req.body);
    const client = await pool.connect();
    try {
      await client.query('begin');
      const c = await loadCaseForPrincipal(req.principal, id, client);
      if (!c) throw new VehicleError('case_not_found', 404);
      await client.query('select 1 from service_cases where id=$1 for update', [id]);
      const verification = { verifiedBy: req.principal.actorId ?? null };
      const current = await loadCaseVehicle(id, client);
      let vehicle: VehicleRow;
      if (current) {
        vehicle = await updateVehicle(current.id, body, client, verification);
      } else {
        const customerActorId = c.customer_actor_id as string | null;
        if (!customerActorId) throw new VehicleError('case_has_no_customer', 409);
        const created = await createCustomerVehicle(customerActorId, newVehicleSchema.parse(body), client);
        vehicle = await updateVehicle(created.id, {}, client, verification);
        await client.query('update service_cases set vehicle_id=$2,updated_at=now() where id=$1', [id, vehicle.id]);
      }
      await client.query('commit');
      await Promise.allSettled([
        appendCaseEvent(id, 'CASE_VEHICLE_CONFIRMED', req.principal, { vehicleId: vehicle.id, fields: Object.keys(body) }),
        audit(req.principal, 'confirm_vehicle', 'customer_vehicle', vehicle.id, 'on_site_confirmation', { caseId: id, fields: Object.keys(body) })
      ]);
      return { vehicle: projectVehicle(req.principal.role, vehicle) };
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      if (error instanceof z.ZodError) return reply.code(400).send({ error: 'vehicle_details_required', details: error.issues });
      return sendVehicleError(reply, error);
    } finally {
      client.release();
    }
  });
}
