import pg from 'pg';
import { env } from '../config/env.js';

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  keepAlive: true
});

pool.on('error', (error) => {
  // Prevent an idle client error from crashing the process without context.
  console.error('postgres_pool_error', error);
});
