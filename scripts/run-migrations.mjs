import { runDatabaseMigrations } from '../src/database/migrate.ts';

try {
  await runDatabaseMigrations();
} catch (error) {
  console.error('[Database] Migration command failed:', error);
  process.exitCode = 1;
}
