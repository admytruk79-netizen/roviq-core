import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { audit } from '../../services/audit.js';
import {
  getPolicy, grantSchema, listGrants, NetworkInventoryError, policySchema, resourceTypes, revokeGrant,
  searchNetworkParts, setGrant, setPolicy, type ResourceType
} from '../../services/network-inventory.js';
import { requireRole } from '../middleware/principal.js';

const resourceParam = z.enum(resourceTypes);

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof NetworkInventoryError) return reply.code(error.status).send({ error: error.code });
  throw error;
}

// A dealership or shop controls its own disclosure and transfer grants. An admin can act for any
// actor (for onboarding or a dealer-group agreement) through the /api/admin/actors/:actorId variant.
async function policies(ownerActorId: string) {
  const entries = await Promise.all(resourceTypes.map(async (r) => [r, await getPolicy(ownerActorId, r)] as const));
  return Object.fromEntries(entries);
}

export async function networkInventoryRoutes(app: FastifyInstance) {
  const owners: { prefix: string; roles: ('partner' | 'admin')[]; owner: (req: { principal: { actorId?: string }; params: unknown }) => string | undefined }[] = [
    { prefix: '/api/partners/me', roles: ['partner'], owner: (req) => req.principal.actorId },
    { prefix: '/api/admin/actors/:actorId', roles: ['admin'], owner: (req) => z.object({ actorId: z.string().uuid() }).parse(req.params).actorId }
  ];

  for (const { prefix, roles, owner } of owners) {
    app.get(`${prefix}/inventory-policies`, { preHandler: requireRole(...roles) }, async (req) => ({ policies: await policies(owner(req)!) }));

    app.put(`${prefix}/inventory-policies/:resourceType`, { preHandler: requireRole(...roles) }, async (req, reply) => {
      const resource = resourceParam.parse((req.params as { resourceType: string }).resourceType) as ResourceType;
      const body = policySchema.parse(req.body);
      const ownerActorId = owner(req)!;
      try {
        const policy = await setPolicy(ownerActorId, resource, body, req.principal.actorId ?? null);
        await audit(req.principal, 'set_inventory_disclosure', 'actor', ownerActorId, resource, body);
        return { policy };
      } catch (error) { return sendError(reply, error); }
    });

    app.get(`${prefix}/transfer-permissions`, { preHandler: requireRole(...roles) }, async (req) => ({ permissions: await listGrants(owner(req)!) }));

    app.put(`${prefix}/transfer-permissions/:granteeActorId/:resourceType`, { preHandler: requireRole(...roles) }, async (req, reply) => {
      const { granteeActorId } = z.object({ granteeActorId: z.string().uuid() }).parse(req.params);
      const resource = resourceParam.parse((req.params as { resourceType: string }).resourceType) as ResourceType;
      const body = grantSchema.parse(req.body);
      const ownerActorId = owner(req)!;
      try {
        const permission = await setGrant(ownerActorId, granteeActorId, resource, body, req.principal.actorId ?? null);
        await audit(req.principal, 'grant_transfer_permission', 'actor', ownerActorId, resource, { granteeActorId, ...body });
        return { permission };
      } catch (error) { return sendError(reply, error); }
    });

    app.delete(`${prefix}/transfer-permissions/:granteeActorId/:resourceType`, { preHandler: requireRole(...roles) }, async (req, reply) => {
      const { granteeActorId } = z.object({ granteeActorId: z.string().uuid() }).parse(req.params);
      const resource = resourceParam.parse((req.params as { resourceType: string }).resourceType) as ResourceType;
      const ownerActorId = owner(req)!;
      try {
        await revokeGrant(ownerActorId, granteeActorId, resource);
        await audit(req.principal, 'revoke_transfer_permission', 'actor', ownerActorId, resource, { granteeActorId });
        return { revoked: true };
      } catch (error) { return sendError(reply, error); }
    });
  }

  // Parts stock at other businesses that the caller is allowed to see: dedicated suppliers, plus
  // dealerships whose disclosure policy admits the caller. Quantities only where disclosed.
  app.get('/api/network/parts', { preHandler: requireRole('partner', 'diagnostic', 'tow', 'parts', 'fleet') }, async (req) => {
    const q = z.object({ sku: z.string().trim().min(1).max(80), quantity: z.coerce.number().int().positive().max(1000).default(1) }).parse(req.query);
    return { matches: await searchNetworkParts(req.principal.actorId!, q.sku, q.quantity) };
  });
}
