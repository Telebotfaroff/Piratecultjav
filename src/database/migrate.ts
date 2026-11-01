import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';

const migrationsDirectory = path.resolve(process.cwd(), 'supabase/migrations');
const advisoryLockKeys = [31415, 92653] as const;

interface MigrationRecord {
  filename: string;
  checksum: string;
}

export async function runDatabaseMigrations(): Promise<void> {
  const connectionString = process.env.DATABASE_URL?.trim();

  if (!connectionString) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('DATABASE_URL is required in production to initialize the Supabase database.');
    }
    console.info('[Database] DATABASE_URL not set; skipping local database migrations.');
    return;
  }

  const client = new Client({
    connectionString,
    // Supabase PostgreSQL requires TLS. The connection string remains a secret
    // and is never printed to logs.
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
    keepAlive: true,
  });

  let locked = false;
  try {
    await client.connect();
    await client.query("SET statement_timeout = '5min'");
    await client.query('SELECT pg_advisory_lock($1, $2)', [...advisoryLockKeys]);
    locked = true;

    await client.query(`
      CREATE TABLE IF NOT EXISTS public._app_migrations (
        filename TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const files = (await readdir(migrationsDirectory))
      .filter((filename) => /^\\d+_[a-z0-9_]+\\.sql$/.test(filename))
      .sort();

    if (files.length === 0) {
      throw new Error('No SQL migration files found in supabase/migrations.');
    }

    let appliedCount = 0;
    for (const filename of files) {
      const sql = await readFile(path.join(migrationsDirectory, filename), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query<MigrationRecord>(
        'SELECT filename, checksum FROM public._app_migrations WHERE filename = $1',
        [filename],
      );

      if (existing.rowCount) {
        if (existing.rows[0].checksum !== checksum) {
          throw new Error(`Applied migration was modified: ${filename}. Create a new migration instead.`);
        }
        continue;
      }

      console.info(`[Database] Applying ${filename}...`);
      await client.query('BEGIN');
      try {
        // Send each complete SQL file as one query. Do not split on semicolons:
        // PL/pgSQL functions contain semicolons inside dollar-quoted bodies.
        await client.query(sql);
        await client.query(
          'INSERT INTO public._app_migrations (filename, checksum) VALUES ($1, $2)',
          [filename, checksum],
        );
        await client.query('COMMIT');
        appliedCount += 1;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`Migration failed: ${filename}`, { cause: error });
      }
    }

    console.info(
      appliedCount
        ? `[Database] Applied ${appliedCount} migration(s); database is ready.`
        : '[Database] Database schema is already up to date.',
    );
  } finally {
    if (locked) {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [...advisoryLockKeys]).catch(() => undefined);
    }
    await client.end().catch(() => undefined);
  }
}
