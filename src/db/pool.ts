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
export function isRetryableConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  if (code && RETRYABLE_CODES.has(code)) return true;
  return /connection terminated unexpectedly|connection terminated|connection reset/i.test(error.message);
}

// Do not transparently retry generic pool.query calls.
// A connection error can arrive after PostgreSQL has committed a write but before the client
// receives the acknowledgement. Reissuing an INSERT/UPDATE/DELETE in that situation can duplicate
// or corrupt business state. Callers that perform read-only work may explicitly retry their own
// SELECT operation using isRetryableConnectionError; writes and transactions must resolve through
// their business idempotency/recovery semantics instead.
