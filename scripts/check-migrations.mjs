import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const directory = new URL('../supabase/migrations/', import.meta.url);
const entries = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
const errors = [];
const versions = new Map();
const legacyDuplicateFiles = {
  '004': ['004_delete_timer.sql', '004_force_sub_chat_id_compat.sql', '004_missed_metadata_codes.sql'],
  '005': ['005_referrals_and_download_plans.sql', '005_screenshot_images.sql'],
};
const baselineFiles = new Set([
  '001_initial_schema.sql',
  '002_retry_recovery.sql',
  '003_force_sub_request_mode.sql',
  '004_delete_timer.sql',
  '004_force_sub_chat_id_compat.sql',
  '004_missed_metadata_codes.sql',
  '005_referrals_and_download_plans.sql',
  '005_screenshot_images.sql',
  '006_access_engine.sql',
  '007_referral_abuse_protection.sql',
  '009_promo_codes.sql',
  '010_star_premium_payments.sql',
  '011_security_indexes.sql',
  '012_video_delivery_analytics.sql',
  '013_live_schema_compatibility.sql',
  '018_configurable_download_quotas.sql',
  '019_referral_locking_hardening.sql',
  '020_promo_hardening.sql',
  '021_stars_payment_hardening.sql',
  '022_phase1_delivery_quota_reliability.sql',
  '023_indexer_worker_leases.sql',
  '024_available_code_search_trgm.sql',
  '025_delivery_analytics_aggregation.sql',
  '026_referral_leaderboard_aggregation.sql',
  '027_service_role_data_api_grants.sql',
  '028_indexer_rpc_signature_alignment.sql',
  '029_v2_historical_indexing_foundation.sql',
]);

if (entries.length === 0) errors.push('No SQL migrations were found.');

for (const name of entries) {
  const match = name.match(/^(\d+)_([a-z0-9_]+)\.sql$/);
  if (!match) {
    errors.push(`Invalid migration filename: ${name}`);
    continue;
  }
  const [, version] = match;
  if (!baselineFiles.has(name) && Number(version) <= 29) {
    errors.push(`New migration must use a version greater than 028: ${name}`);
  }
  const paths = versions.get(version) || [];
  paths.push(name);
  versions.set(version, paths);

  const sql = (await readFile(join(directory.pathname, name), 'utf8')).trim();
  if (!sql) errors.push(`Migration is empty: ${name}`);
}

for (const [version, names] of versions) {
  if (names.length > 1) {
    const expected = legacyDuplicateFiles[version] || [];
    if (names.length !== expected.length || expected.some((name) => !names.includes(name))) {
      errors.push(`Unexpected files reuse migration version ${version}: ${names.join(', ')}`);
    } else {
      console.warn(`Legacy duplicate migration version ${version}: ${names.join(', ')}`);
    }
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
if (!Number.isFinite(highestVersion) || highestVersion < 28) {
  errors.push('Expected the repository migration baseline through version 029.');
}

if (errors.length) {
  console.error('Migration verification failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Verified ${entries.length} SQL migration files (latest version: ${String(highestVersion).padStart(3, '0')}).`);
  console.log('New migrations must use a unique numeric version greater than 029.');
}
