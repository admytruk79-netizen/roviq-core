import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { audit } from '../../services/audit.js';
import { requireRole } from '../middleware/principal.js';

const marketBody = z.object({
  slug: z.string().min(2),
  countryCode: z.string().length(2).transform(v => v.toUpperCase()),
  region: z.string().optional(),
  city: z.string().optional(),
  timezone: z.string().min(1),
  status: z.enum(['active','inactive']).default('active')
});

const organizationBody = z.object({
  organizationType: z.string().min(1),
  legalName: z.string().optional(),
  displayName: z.string().min(1),
  contactMetadata: z.record(z.unknown()).default({})
});

const locationBody = z.object({
  organizationId: z.string().uuid().optional(),
  marketId: z.string().uuid().optional(),
  name: z.string().optional(),
  address: z.string().optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  countryCode: z.string().length(2).optional(),
  region: z.string().optional(),
  city: z.string().optional(),
  metadata: z.record(z.unknown()).default({})
});

export async function coreRoutes(app: FastifyInstance) {
  app.get('/api/core/markets', async () => {
    const r = await pool.query(`select id,slug,country_code,region,city,timezone,status from markets where status='active' order by country_code,region,city`);
    return { markets: r.rows };
  });

  app.post('/api/core/markets', { preHandler: requireRole('admin') }, async (req, reply) => {
    const b = marketBody.parse(req.body);
    const r = await pool.query(
      `insert into markets(slug,country_code,region,city,timezone,status) values($1,$2,$3,$4,$5,$6) returning *`,
      [b.slug,b.countryCode,b.region ?? null,b.city ?? null,b.timezone,b.status]
    );
    await audit(req.principal,'create_market','market',r.rows[0].id,'platform_core');
    return reply.code(201).send({ market:r.rows[0] });
  });

  app.get('/api/core/organizations/:id', { preHandler: requireRole('admin','partner','diagnostic','tow','parts','fleet') }, async (req, reply) => {
    const { id } = req.params as { id:string };
    const r = await pool.query('select * from organizations where id=$1',[id]);
    if (!r.rowCount) return reply.code(404).send({ error:'organization_not_found' });

    if (req.principal.role !== 'admin') {
      const owned = await pool.query('select 1 from actors where id=$1 and organization_id=$2',[req.principal.actorId,id]);
      if (!owned.rowCount) return reply.code(403).send({ error:'forbidden' });
    }
    return { organization:r.rows[0] };
  });

  app.post('/api/core/organizations', { preHandler: requireRole('admin') }, async (req, reply) => {
    const b = organizationBody.parse(req.body);
    const r = await pool.query(
      `insert into organizations(organization_type,legal_name,display_name,contact_metadata) values($1,$2,$3,$4) returning *`,
      [b.organizationType,b.legalName ?? null,b.displayName,b.contactMetadata]
    );
    await audit(req.principal,'create_organization','organization',r.rows[0].id,'platform_core');
    return reply.code(201).send({ organization:r.rows[0] });
  });

  app.post('/api/core/locations', { preHandler: requireRole('admin') }, async (req, reply) => {
    const b = locationBody.parse(req.body);
    const r = await pool.query(
      `insert into locations(organization_id,market_id,name,address,latitude,longitude,country_code,region,city,metadata)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
      [b.organizationId ?? null,b.marketId ?? null,b.name ?? null,b.address ?? null,b.latitude ?? null,b.longitude ?? null,b.countryCode?.toUpperCase() ?? null,b.region ?? null,b.city ?? null,b.metadata]
    );
    await audit(req.principal,'create_location','location',r.rows[0].id,'platform_core');
    return reply.code(201).send({ location:r.rows[0] });
  });

  app.get('/api/core/locations/:id', async (req, reply) => {
    const { id } = req.params as { id:string };
    const r = await pool.query(
      `select l.*, m.slug as market_slug, o.display_name as organization_name
       from locations l left join markets m on m.id=l.market_id left join organizations o on o.id=l.organization_id
       where l.id=$1`, [id]
    );
    if (!r.rowCount) return reply.code(404).send({ error:'location_not_found' });
    return { location:r.rows[0] };
  });
}
