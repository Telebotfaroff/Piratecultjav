# Database migration notes

The repository currently contains 24 SQL migration files through version 027.

## Important legacy naming issue

The historical files include repeated numeric prefixes:

- `004_delete_timer.sql`
- `004_force_sub_chat_id_compat.sql`
- `004_missed_metadata_codes.sql`
- `005_referrals_and_download_plans.sql`
- `005_screenshot_images.sql`

The CI migration check preserves these existing filenames as a known legacy exception and rejects any new duplicate version. A clean migration-history baseline is required before relying on automated CLI ordering; do not run `supabase db push` against a production project until the intended project and its migration history have been confirmed and the legacy versions have been reconciled.

## Adding a migration

1. Create the migration using the Supabase CLI's migration generator.
2. Use a unique version greater than `027`.
3. Keep the SQL idempotent where practical and review locking/availability impact.
4. Run `npm run check:migrations`, tests, and CI.
5. Apply only after confirming the target Supabase project and reviewing its current migration history.
6. Verify the resulting schema and run Supabase security/performance advisors.
