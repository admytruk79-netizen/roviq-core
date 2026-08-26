import { readdir } from 'node:fs/promises';
import path from 'node:path';

const migrationsDir = path.resolve(process.cwd(), 'migrations');
const LEGACY_DUPLICATES = new Map([
  ['003', new Set(['003_identity.sql', '003_platform_core.sql'])]
]);

const files = (await readdir(migrationsDir))
  .filter((file) => /^\d{3}.*\.sql$/.test(file))
  .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));

if (!files.length) throw new Error('No migrations found');

const byPrefix = new Map();
for (const file of files) {
  const prefix = file.slice(0, 3);
  if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
  byPrefix.get(prefix).push(file);
}

for (const [prefix, names] of byPrefix) {
  if (names.length === 1) continue;
  const allowed = LEGACY_DUPLICATES.get(prefix);
  const actual = new Set(names);
  const exactLegacyMatch = allowed
    && allowed.size === actual.size
    && [...allowed].every((name) => actual.has(name));
  if (!exactLegacyMatch) {
    throw new Error(`Duplicate migration prefix ${prefix}: ${names.join(', ')}`);
  }
}

const numericPrefixes = [...byPrefix.keys()].map(Number);
for (let i = 1; i < numericPrefixes.length; i += 1) {
  if (numericPrefixes[i] <= numericPrefixes[i - 1]) {
    throw new Error(`Migration prefixes are not strictly increasing: ${numericPrefixes[i - 1]} -> ${numericPrefixes[i]}`);
  }
}

const legacy = byPrefix.get('003') || [];
if (legacy.length) {
  console.log(`Legacy migration collision preserved safely: ${legacy.join(' -> ')}`);
}
console.log(`Migration integrity OK: ${files.length} files, ${byPrefix.size} numeric prefixes.`);
