import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const directory = new URL('../supabase/migrations/', import.meta.url);
const entries = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
const errors = [];
const versions = new Map();
const legacyDuplicateVersions = new Set(['004', '005']);

if (entries.length === 0) errors.push('No SQL migrations were found.');

for (const name of entries) {
  const match = name.match(/^(\d+)_([a-z0-9_]+)\.sql$/);
  if (!match) {
    errors.push(`Invalid migration filename: ${name}`);
    continue;
  }
  const [, version] = match;
  const paths = versions.get(version) || [];
  paths.push(name);
  versions.set(version, paths);

  const sql = (await readFile(join(directory.pathname, name), 'utf8')).trim();
  if (!sql) errors.push(`Migration is empty: ${name}`);
}

for (const [version, names] of versions) {
  if (names.length > 1 && !legacyDuplicateVersions.has(version)) {
    errors.push(`Duplicate migration version ${version}: ${names.join(', ')}`);
  } else if (names.length > 1) {
    console.warn(`Legacy duplicate migration version ${version}: ${names.join(', ')}`);
  }
}

const accessMigrationPath = join(directory.pathname, '027_service_role_data_api_grants.sql');
try {
  const accessMigration = await readFile(accessMigrationPath, 'utf8');
  for (const [label, pattern] of [
    ['service_role table grants', /GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO service_role/i],
    ['service_role sequence grants', /GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO service_role/i],
    ['RLS enablement', /ENABLE ROW LEVEL SECURITY/i],
    ['default table grants', /ALTER DEFAULT PRIVILEGES[\s\S]*?GRANT ALL PRIVILEGES ON TABLES TO service_role/i],
  ]) {
    if (!pattern.test(accessMigration)) errors.push(`Migration 027 is missing ${label}.`);
  }
} catch {
  errors.push('Required migration 027_service_role_data_api_grants.sql is missing.');
}

const highestVersion = Math.max(...Array.from(versions.keys(), Number));
if (!Number.isFinite(highestVersion) || highestVersion < 27) {
  errors.push('Expected the repository migration baseline through version 027.');
}

if (errors.length) {
  console.error('Migration verification failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Verified ${entries.length} SQL migration files (latest version: ${String(highestVersion).padStart(3, '0')}).`);
  console.log('New migrations must use a unique numeric version greater than 027.');
}
