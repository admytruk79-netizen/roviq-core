import { z } from 'zod';
import { pool } from '../db/pool.js';

// Dealership inventory is private until its owner says otherwise. This module is the single place
// that decides (a) which other businesses may SEE an actor's stock and how much of it, and (b)
// whose stock Core may automatically SOURCE for someone else's job. Dedicated parts suppliers
// (actor_type 'parts') sell to the network by nature and are always sourceable and visible.

export const resourceTypes = ['parts', 'service_capacity', 'mobility'] as const;
export type ResourceType = (typeof resourceTypes)[number];

export const policySchema = z.object({
  visibility: z.enum(['private', 'same_organization', 'named_partners', 'network']),
  detail: z.enum(['availability_only', 'quantity']).default('availability_only')
});

export const grantSchema = z.object({
  canView: z.boolean().default(true),
  canRequestTransfer: z.boolean().default(false),
  requiresAcceptance: z.boolean().default(true),
  terms: z.record(z.unknown()).default({}),
  expiresAt: z.string().datetime().nullable().optional()
});

export class NetworkInventoryError extends Error {
  constructor(public code: string, public status: number) { super(code); }
}

const ACTIVE_GRANT = `tp.active and (tp.expires_at is null or tp.expires_at > now())`;

/**
 * SQL condition: may Core automatically commit stock owned by `ownerColumn` to work performed by
 * the actor bound at `granteeParam`? Yes for dedicated parts suppliers, for the grantee's own
 * stock, and for stock whose owner granted the grantee an active transfer permission. A null
 * grantee (no known repairing actor) can only use dedicated suppliers.
 */
export function sourcingAllowedSql(ownerColumn: string, ownerTypeColumn: string, granteeParam: string, resource: ResourceType = 'parts') {
  return `(${ownerTypeColumn} = 'parts'
    or (${granteeParam}::uuid is not null and ${ownerColumn} = ${granteeParam}::uuid)
    or exists(select 1 from transfer_permissions tp
               where tp.grantor_actor_id = ${ownerColumn} and tp.grantee_actor_id = ${granteeParam}::uuid
                 and tp.resource_type = '${resource}' and tp.can_request_transfer and ${ACTIVE_GRANT}))`;
}

export async function getPolicy(ownerActorId: string, resource: ResourceType) {
  const r = await pool.query(
    `select visibility, detail, updated_at from inventory_disclosure_policies where owner_actor_id=$1 and resource_type=$2`,
    [ownerActorId, resource]
  );
  return r.rows[0] ?? { visibility: 'private', detail: 'availability_only', updated_at: null };
}

export async function setPolicy(ownerActorId: string, resource: ResourceType, policy: z.infer<typeof policySchema>, byActorId: string | null) {
  const owner = await pool.query(`select 1 from actors where id=$1`, [ownerActorId]);
  if (!owner.rowCount) throw new NetworkInventoryError('actor_not_found', 404);
  const r = await pool.query(
    `insert into inventory_disclosure_policies(owner_actor_id,resource_type,visibility,detail,updated_by_actor_id)
     values($1,$2,$3,$4,$5)
     on conflict(owner_actor_id,resource_type) do update
       set visibility=excluded.visibility, detail=excluded.detail, updated_by_actor_id=excluded.updated_by_actor_id, updated_at=now()
     returning visibility, detail, updated_at`,
    [ownerActorId, resource, policy.visibility, policy.detail, byActorId]
  );
  return r.rows[0];
}

export async function listGrants(grantorActorId: string) {
  const r = await pool.query(
    `select tp.grantee_actor_id, tp.resource_type, tp.can_view, tp.can_request_transfer, tp.requires_acceptance,
            tp.terms, tp.active, tp.expires_at, tp.updated_at,
            coalesce(a.attributes->>'displayName', o.display_name) as grantee_name
       from transfer_permissions tp
       join actors a on a.id = tp.grantee_actor_id
       left join organizations o on o.id = a.organization_id
      where tp.grantor_actor_id=$1 and tp.active
      order by tp.updated_at desc`,
    [grantorActorId]
  );
  return r.rows;
}

export async function setGrant(grantorActorId: string, granteeActorId: string, resource: ResourceType, grant: z.infer<typeof grantSchema>, byActorId: string | null) {
  if (grantorActorId === granteeActorId) throw new NetworkInventoryError('cannot_grant_self', 400);
  const grantee = await pool.query(`select 1 from actors where id=$1 and status='active'`, [granteeActorId]);
  if (!grantee.rowCount) throw new NetworkInventoryError('grantee_not_found', 404);
  const r = await pool.query(
    `insert into transfer_permissions(grantor_actor_id,grantee_actor_id,resource_type,can_view,can_request_transfer,requires_acceptance,terms,expires_at,created_by_actor_id)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict(grantor_actor_id,grantee_actor_id,resource_type) do update
       set can_view=excluded.can_view, can_request_transfer=excluded.can_request_transfer,
           requires_acceptance=excluded.requires_acceptance, terms=excluded.terms, expires_at=excluded.expires_at,
           active=true, updated_at=now()
     returning grantee_actor_id, resource_type, can_view, can_request_transfer, requires_acceptance, terms, active, expires_at`,
    [grantorActorId, granteeActorId, resource, grant.canView, grant.canRequestTransfer, grant.requiresAcceptance,
      JSON.stringify(grant.terms), grant.expiresAt ?? null, byActorId]
  );
  return r.rows[0];
}

export async function revokeGrant(grantorActorId: string, granteeActorId: string, resource: ResourceType) {
  const r = await pool.query(
    `update transfer_permissions set active=false, updated_at=now()
      where grantor_actor_id=$1 and grantee_actor_id=$2 and resource_type=$3 and active returning 1`,
    [grantorActorId, granteeActorId, resource]
  );
  if (!r.rowCount) throw new NetworkInventoryError('grant_not_found', 404);
}

export type NetworkPartMatch = {
  ownerActorId: string;
  ownerName: string | null;
  sourceType: 'supplier' | 'dealership';
  sku: string;
  available: boolean;
  quantityAvailable: number | null;
  canRequestTransfer: boolean;
};

/**
 * Parts stock from OTHER businesses that `viewerActorId` is allowed to see for a SKU. A
 * dealership's stock appears only when its disclosure policy admits the viewer, and its quantity
 * only when the policy discloses quantity. Nothing about a dealership that has not opted in --
 * not even that it carries the SKU -- is returned.
 */
export async function searchNetworkParts(viewerActorId: string, sku: string, quantity = 1): Promise<NetworkPartMatch[]> {
  const r = await pool.query(
    `select pi.supplier_actor_id as owner_actor_id, a.actor_type,
            coalesce(a.attributes->>'displayName', o.display_name) as owner_name,
            sum(greatest(pi.quantity_on_hand - pi.quantity_reserved, 0))::int as available_quantity,
            coalesce(p.detail, 'availability_only') as detail,
            exists(select 1 from transfer_permissions tp
                    where tp.grantor_actor_id = pi.supplier_actor_id and tp.grantee_actor_id = $1
                      and tp.resource_type = 'parts' and tp.can_request_transfer and ${ACTIVE_GRANT}) as can_request_transfer
       from parts_inventory pi
       join actors a on a.id = pi.supplier_actor_id and a.status = 'active'
       left join organizations o on o.id = a.organization_id
       left join inventory_disclosure_policies p on p.owner_actor_id = pi.supplier_actor_id and p.resource_type = 'parts'
       join actors viewer on viewer.id = $1
      where pi.active and upper(pi.sku) = upper($2) and pi.supplier_actor_id <> $1
        and (
          a.actor_type = 'parts'
          or p.visibility = 'network'
          or (p.visibility = 'same_organization' and a.organization_id is not null and a.organization_id = viewer.organization_id)
          or (p.visibility = 'named_partners' and exists(
                select 1 from transfer_permissions tp
                 where tp.grantor_actor_id = pi.supplier_actor_id and tp.grantee_actor_id = $1
                   and tp.resource_type = 'parts' and tp.can_view and ${ACTIVE_GRANT}))
        )
      group by pi.supplier_actor_id, a.actor_type, a.attributes, o.display_name, p.detail
      order by (a.actor_type = 'parts'), available_quantity desc`,
    [viewerActorId, sku]
  );
  return r.rows.map((row) => {
    const supplier = row.actor_type === 'parts';
    const qty = Number(row.available_quantity);
    return {
      ownerActorId: row.owner_actor_id,
      ownerName: row.owner_name,
      sourceType: supplier ? 'supplier' : 'dealership',
      sku,
      available: qty >= quantity,
      quantityAvailable: supplier || row.detail === 'quantity' ? qty : null,
      canRequestTransfer: supplier || row.can_request_transfer
    };
  });
}
