import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool } from './pool.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migration = path.resolve(here, '../../migrations/001_core.sql');
const sql = await readFile(migration, 'utf8');
await pool.query(sql);
console.log('ROVIQ Core migration applied.');
await pool.end();
