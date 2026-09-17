import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { audit } from '../../services/audit.js';
import { requireRole } from '../middleware/principal.js';
import { getActiveMembership } from '../../services/consumer-membership.js';

export async function membershipRoutes(app: FastifyInstance) {
  app.get('/api/admin/membership-plans', { preHandler: requireRole('admin') }, async () => {
    const r = await pool.query('select * from membership_plans where active=true order by monthly_price_minor asc');
    return { plans: r.rows };
  });

  app.get('/api/customers/me/membership', { preHandler: requireRole('customer') }, async (req) => {
    const membership = await getActiveMembership(req.principal.actorId!);
    if (!membership) return { membership: null };
    return {
      membership: {
        planKey: membership.planKey,
        includedDiagnosticsPerPeriod: membership.includedDiagnosticsPerPeriod,
        diagnosticsUsedThisPeriod: membership.diagnosticsUsedThisPeriod,
        diagnosticsRemainingThisPeriod: Math.max(0, membership.includedDiagnosticsPerPeriod - membership.diagnosticsUsedThisPeriod),
        maxLoanerTier: membership.maxLoanerTier
      }
    };
  });

  // Admin-only for now: no payment collection is wired to plan enrollment itself yet (recurring
  // billing is a materially bigger integration than the one-off diagnostic fee this unlocks), so
  // this is how a plan gets attached to a customer until self-serve signup exists.
  app.post('/api/admin/customers/:actorId/membership', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { actorId } = req.params as { actorId: string };
    const body = z.object({ planKey: z.string().min(1) }).parse(req.body);
    const actor = await pool.query(`select id from actors where id=$1 and actor_type='customer' and status='active'`,[actorId]);
    if (!actor.rowCount) return reply.code(404).send({ error: 'customer_not_found' });
    const plan = await pool.query(`select id,period_days from membership_plans where plan_key=$1 and active=true`,[body.planKey]);
    if (!plan.rowCount) return reply.code(400).send({ error: 'unknown_plan' });
    const r = await pool.query(
      `insert into customer_memberships(customer_actor_id,plan_id,status,current_period_start,current_period_end)
       values($1,$2,'active',now(),now()+($3||' days')::interval)
       on conflict(customer_actor_id) do update set
         plan_id=excluded.plan_id, status='active',
         current_period_start=now(), current_period_end=now()+($3||' days')::interval,
         diagnostics_used_this_period=0, updated_at=now()
       returning *`,
      [actorId, plan.rows[0].id, plan.rows[0].period_days]
    );
    await audit(req.principal,'set_customer_membership','customer_membership',r.rows[0].id,body.planKey,{ customerActorId: actorId });
    return reply.code(201).send({ membership: r.rows[0] });
  });
}
