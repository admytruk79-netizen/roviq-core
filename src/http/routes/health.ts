import type { FastifyInstance } from 'fastify';
import { pool } from '../../db/pool.js';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async () => ({ ok: true, service: 'roviq-core' }));

  app.get('/ready', async (_req, reply) => {
    try {
      const result = await pool.query('select now() as database_time');
      return {
        ok: true,
        service: 'roviq-core',
        database: 'reachable',
        databaseTime: result.rows[0]?.database_time ?? null
      };
    } catch (error) {
      app.log.error(error);
      return reply.code(503).send({
        ok: false,
        service: 'roviq-core',
        database: 'unreachable'
      });
    }
  });
}
