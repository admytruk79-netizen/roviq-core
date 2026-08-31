import type { FastifyInstance } from 'fastify';
import { pool } from '../../db/pool.js';

function deployedRevision() {
  return process.env.RENDER_GIT_COMMIT ?? process.env.GITHUB_SHA ?? null;
}

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', { config: { public: true } }, async () => ({
    ok: true,
    service: 'roviq-core',
    revision: deployedRevision()
  }));

  app.get('/ready', { config: { public: true } }, async (_req, reply) => {
    try {
      const result = await pool.query('select now() as database_time');
      return {
        ok: true,
        service: 'roviq-core',
        revision: deployedRevision(),
        database: 'reachable',
        databaseTime: result.rows[0]?.database_time ?? null
      };
    } catch (error) {
      app.log.error(error);
      return reply.code(503).send({
        ok: false,
        service: 'roviq-core',
        revision: deployedRevision(),
        database: 'unreachable'
      });
    }
  });
}
