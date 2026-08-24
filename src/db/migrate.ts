import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool } from './pool.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '../../migrations');
const advisoryLockId = 7_605_173_481;

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
        throw new Error(`Migration checksum mismatch: ${filename}`);
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
} finally {
  await client.query('select pg_advisory_unlock($1::bigint)', [advisoryLockId]).catch(() => undefined);
  client.release();
  await pool.end();
}
