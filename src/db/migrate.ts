import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool } from './pool.js';
import { hashPassword } from '../services/auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '../../migrations');
const advisoryLockId = 7_605_173_481;

// Migration 017 was edited after its first production application on Aug 28.
// Production therefore legitimately contains the original checksum while the
// repository contains the later, expanded file. Keep checksum enforcement
// strict everywhere else, but accept that one known historical checksum so
// Render can continue to later idempotent alignment migrations (notably 022).
const acceptedHistoricalChecksums: Record<string, ReadonlySet<string>> = {
  '017_coherence_invariants.sql': new Set([
    '0c79975d4149019aa5ad433f6c4911ce622a29d5e93757970296d756731ba121'
  ])
};

const files = (await readdir(migrationsDir))
  .filter((file) => /^\d{3}.*\.sql$/.test(file))
  .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));

if (!files.length) throw new Error(`No migrations found in ${migrationsDir}`);

const client = await pool.connect();
try {
  await client.query('select pg_advisory_lock($1::bigint)', [advisoryLockId]);
  await client.query(`
    create table if not exists schema_migrations (
      filename text primary key,
      checksum_sha256 text not null,
      applied_at timestamptz not null default now(),
      duration_ms integer not null
    )
  `);

  let applied = 0;
  for (const filename of files) {
    const sql = await readFile(path.join(migrationsDir, filename), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const existing = await client.query<{ checksum_sha256: string }>(
      'select checksum_sha256 from schema_migrations where filename=$1',
      [filename]
    );

    if (existing.rowCount) {
      if (existing.rows[0].checksum_sha256 !== checksum) {
        const accepted = acceptedHistoricalChecksums[filename]?.has(existing.rows[0].checksum_sha256) ?? false;
        if (!accepted) throw new Error(`Migration checksum mismatch: ${filename}`);
        console.warn(`Accepted historical checksum for ${filename}; later alignment migrations remain authoritative.`);
      }
      continue;
    }

    const startedAt = Date.now();
    await client.query('begin');
    try {
      await client.query(sql);
      await client.query(
        `insert into schema_migrations(filename,checksum_sha256,duration_ms)
         values($1,$2,$3)`,
        [filename, checksum, Date.now() - startedAt]
      );
      await client.query('commit');
      applied += 1;
      console.log(`Applied ${filename}`);
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  }

  console.log(`ROVIQ migrations complete: ${applied} applied, ${files.length - applied} already current.`);

  const bootstrapEmail = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const bootstrapPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (bootstrapEmail && bootstrapPassword) {
    const existingAdmin = await client.query(`select 1 from principal_identities where role='admin' limit 1`);
    if (!existingAdmin.rowCount) {
      if (bootstrapPassword.length < 12) {
        console.error('Bootstrap admin skipped: BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters.');
      } else {
        const { salt, hash } = hashPassword(bootstrapPassword);
        await client.query(
          `insert into principal_identities(email,role,password_salt,password_hash)
           values(lower($1),'admin',$2,$3)
           on conflict(email) do nothing`,
          [bootstrapEmail, salt, hash]
        );
        console.log(`Bootstrap admin identity ensured for ${bootstrapEmail.toLowerCase()}.`);
      }
    } else {
      console.log('Bootstrap admin skipped: an admin identity already exists.');
    }
  }
} finally {
  await client.query('select pg_advisory_unlock($1::bigint)', [advisoryLockId]).catch(() => undefined);
  client.release();
  await pool.end();
}
