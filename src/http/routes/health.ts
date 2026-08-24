import type { FastifyInstance } from 'fastify';
import { pool } from '../../db/pool.js';
import { env } from '../../config/env.js';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async () => ({
    ok: true,
    service: 'roviq-core',
    role: 'canonical-fastify-core'
  }));

  app.get('/ready', async (_req, reply) => {
    try {
      const database = await pool.query('select now() as database_time, current_database() as database_name');
      const migration = await pool.query<{ filename: string }>(
        'select filename from schema_migrations where filename=$1 limit 1',
        [env.REQUIRED_MIGRATION]
      );

      if (!migration.rowCount) {
        return reply.code(503).send({
          ok: false,
          service: 'roviq-core',
          database: 'reachable',
          migrations: 'pending',
          requiredMigration: env.REQUIRED_MIGRATION
        });
      }

      return {
        ok: true,
        service: 'roviq-core',
        database: 'reachable',
        migrations: 'current',
        requiredMigration: env.REQUIRED_MIGRATION,
        databaseTime: database.rows[0]?.database_time ?? null,
        databaseName: database.rows[0]?.database_name ?? null
      };
    } catch (error) {
      console.error('roviq_readiness_error', error);
      return reply.code(503).send({
        ok: false,
        service: 'roviq-core',
        database: 'unreachable',
        migrations: 'unknown'
      });
    }
  });
}
