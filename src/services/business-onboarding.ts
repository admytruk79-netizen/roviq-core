import { createHash } from 'node:crypto';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { hashPassword, verifyPasswordConstantTime } from './auth.js';
import { validIdentityId } from './audit.js';
import type { Principal } from '../types/principal.js';

export const businessOnboardingSchema = z.object({
  requestId: z.string().uuid(),
  role: z.enum(['partner', 'diagnostic', 'tow', 'parts', 'fleet']),
  businessName: z.string().trim().min(2).max(120),
  operatorName: z.string().trim().min(2).max(100),
  email: z.string().trim().email().max(254).transform(v => v.toLowerCase()),
  password: z.string().min(12).max(128),
  location: z.object({
    name: z.string().trim().min(2).max(120), address: z.string().trim().min(3).max(300),
    city: z.string().trim().min(2).max(100), region: z.string().trim().min(2).max(100),
    countryCode: z.string().trim().regex(/^[a-z]{2}$/i).transform(v => v.toUpperCase())
  })
});
export class BusinessOnboardingError extends Error {
  constructor(public code: string, public status: number) { super(code); }
}
const organizationType = { partner: 'repair_partner', diagnostic: 'diagnostic_provider', tow: 'transport_provider', parts: 'parts_supplier', fleet: 'mobility_provider' };

export async function onboardBusiness(principal: Principal, input: z.infer<typeof businessOnboardingSchema>) {
  if (principal.role !== 'admin') throw new BusinessOnboardingError('forbidden', 403);
  const { password, requestId, ...details } = input;
  // No password or password-derived digest is stored in actor attributes or audit metadata.
  const fingerprint = createHash('sha256').update(JSON.stringify(details)).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('begin');
    // The actor UUID is also the retry key. Serialize competing submissions of that key.
    await client.query(`select pg_advisory_xact_lock(hashtextextended($1,0))`, [`business-onboarding:${requestId}`]);
    const previous = await client.query(`select a.id,a.organization_id,a.location_id,a.attributes,
      p.id as identity_id,p.password_salt,p.password_hash,p.active
      from actors a left join principal_identities p on p.actor_id=a.id and p.role=a.actor_type and lower(p.email)=$2
      where a.id=$1`, [requestId, input.email]);
    if (previous.rowCount) {
      const row = previous.rows[0];
      if (row.attributes.onboardingFingerprint !== fingerprint || !row.active ||
          !verifyPasswordConstantTime(password, row.password_salt, row.password_hash)) {
        throw new BusinessOnboardingError('onboarding_retry_conflict', 409);
      }
      await client.query('commit');
      return { actorId: row.id, organizationId: row.organization_id, locationId: row.location_id,
        identityId: row.identity_id, role: input.role, email: input.email, readiness: 'configuration_required', replayed: true };
    }
    const domain = await client.query(`select id from domains where code='maintenance' and status='active'`);
    if (!domain.rowCount) throw new BusinessOnboardingError('maintenance_domain_unavailable', 409);
    const organization = await client.query(`insert into organizations(organization_type,display_name,status)
      values($1,$2,'active') returning id`, [organizationType[input.role], input.businessName]);
    const organizationId = organization.rows[0].id;
    const location = await client.query(`insert into locations(organization_id,name,address,city,region,country_code)
      values($1,$2,$3,$4,$5,$6) returning id`, [organizationId, input.location.name, input.location.address,
      input.location.city, input.location.region, input.location.countryCode]);
    const locationId = location.rows[0].id;
    await client.query(`insert into actors(id,domain_id,actor_type,status,organization_id,location_id,attributes)
      values($1,$2,$3,'active',$4,$5,$6)`, [requestId, domain.rows[0].id, input.role, organizationId, locationId,
      JSON.stringify({ displayName: input.operatorName, onboardingFingerprint: fingerprint, onboardingSource: 'ops_business_onboarding' })]);
    const { salt, hash } = hashPassword(password);
    const identity = await client.query(`insert into principal_identities(actor_id,email,role,password_salt,password_hash)
      values($1,$2,$3,$4,$5) returning id`, [requestId, input.email, input.role, salt, hash]);
    if (input.role === 'partner') {
      await client.query(`insert into partner_controls(actor_id,routing_enabled,accepts_overflow)
        values($1,false,false)`, [requestId]);
    }
    await client.query(`insert into audit_log(principal_role,principal_actor_id,principal_identity_id,action,object_type,object_id,rule_basis,metadata)
      values('admin',$1,$2,'onboard_business','actor',$3,'ops_business_onboarding',$4)`,
    [principal.actorId ?? null, validIdentityId(principal.identityId), requestId,
      JSON.stringify({ organizationId, locationId, identityId: identity.rows[0].id, role: input.role, readiness: 'configuration_required' })]);
    await client.query('commit');
    return { actorId: requestId, organizationId, locationId, identityId: identity.rows[0].id,
      role: input.role, email: input.email, readiness: 'configuration_required', replayed: false };
  } catch (error) {
    await client.query('rollback');
    if ((error as { code?: string }).code === '23505') throw new BusinessOnboardingError('onboarding_identity_or_request_exists', 409);
    throw error;
  } finally { client.release(); }
}

export async function listOnboardedBusinesses() {
  const result = await pool.query(`select a.id as "actorId",a.actor_type as role,a.status,
    a.organization_id as "organizationId",a.location_id as "locationId",o.display_name as "businessName",
    a.attributes->>'displayName' as "operatorName",p.email,l.name as "locationName",a.created_at as "createdAt"
    from actors a join organizations o on o.id=a.organization_id
    join locations l on l.id=a.location_id
    join principal_identities p on p.actor_id=a.id and p.role=a.actor_type
    where a.attributes->>'onboardingSource'='ops_business_onboarding'
    order by a.created_at desc,a.id limit 100`);
  return result.rows;
}
