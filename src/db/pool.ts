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

// Neon's serverless Postgres occasionally drops or resets a connection mid-query under
// concurrent load (observed as ECONNRESET / "Connection terminated unexpectedly" from
// otherwise-trivial single SELECTs). Such a failure happens at the connection layer before
// the statement could have taken effect, so retrying once is safe -- it is not a business
// logic error and never succeeds on retry if it were. Only these specific transient
// connection errors are retried; anything else (constraint violations, syntax errors,
// application-thrown errors) is rethrown immediately.
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', '57P01', '08006', '08003']);
function isRetryableConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  if (code && RETRYABLE_CODES.has(code)) return true;
  return /connection terminated unexpectedly|connection terminated|connection reset/i.test(error.message);
}

const originalQuery = pool.query.bind(pool);
// @ts-expect-error -- overriding pg.Pool#query with a retrying wrapper; the runtime signature
// (args forwarded as-is to the original) matches every overload callers actually use.
pool.query = async function retryingQuery(...args: unknown[]) {
  try {
    return await originalQuery(...(args as Parameters<typeof originalQuery>));
  } catch (error) {
    if (!isRetryableConnectionError(error)) throw error;
    console.warn('postgres_transient_error_retrying', { message: (error as Error).message });
    return await originalQuery(...(args as Parameters<typeof originalQuery>));
  }
};
