# ROVIQ Core Recovery Runbook

This runbook is the production procedure for database backup/restore, migration failure, and service recovery. It complements `PRODUCTION_READINESS_EXECUTION_PLAN.md`.

## Recovery principles

ROVIQ Core treats PostgreSQL as the system of record. Recovery favors preserving canonical data and auditability over attempting risky in-place reversals.

- Schema migrations are forward-only.
- Each new migration runs inside its own database transaction.
- A failed migration must leave no partial schema change from that migration.
- Do not edit a migration that has already been applied to production. Add a new alignment/repair migration.
- Application rollback and database rollback are separate decisions. Rolling the application back does not automatically reverse schema.
- Before any destructive recovery action, take a new database backup whenever the database is still reachable.
- Restore into an isolated database first. Never test a restore by overwriting the only production database.

## Automated evidence in CI

The system-acceptance job now proves a real PostgreSQL backup and restore on every qualifying CI run:

1. migrate a fresh PostgreSQL database,
2. run the complete Core acceptance suite,
3. create a `pg_dump --format=custom` backup,
4. restore that dump into a second clean database,
5. verify the migration ledger and critical canonical tables.

A green acceptance job therefore provides evidence that the current schema and representative data can be backed up and restored with PostgreSQL-native tooling.

## Production backup

Use the provider's managed backup/PITR facility as the primary production protection. Before a risky migration, additionally create an export if operationally practical:

```bash
pg_dump "$DATABASE_URL" \
  --format=custom \
  --no-owner \
  --no-acl \
  --file="roviq-$(date -u +%Y%m%dT%H%M%SZ).dump"
```

Treat dump files as production secrets. They can contain customer, partner, vehicle, payment, diagnostic, and operational data. Store them only in an approved encrypted location and apply the same access controls as the production database.

## Restore verification

Create an isolated target database and restore:

```bash
createdb roviq_restore_verify
pg_restore \
  --dbname=roviq_restore_verify \
  --no-owner \
  --no-acl \
  roviq-YYYYMMDDTHHMMSSZ.dump
```

Verify at minimum:

```sql
select filename, applied_at
from schema_migrations
order by filename desc
limit 10;

select count(*) from service_cases;
select count(*) from events;
select count(*) from audit_log;
select count(*) from payment_intents;
select count(*) from ledger_entries;
```

Then run the application readiness probe against the restored database and, where possible, the Core acceptance suite in a non-production environment.

## Migration failure

If deployment fails while running `db:migrate`:

1. Do not manually mark the migration as applied.
2. Capture the failing filename and PostgreSQL error.
3. Confirm the failed filename is absent from `schema_migrations`.
4. Confirm the database transaction rolled back the migration's changes.
5. Fix the migration on a new commit before retrying deployment.
6. If the migration had already been applied in another environment, do not rewrite it. Create a new repair/alignment migration.
7. Re-run fresh-database migration acceptance before deploying again.

The migrator uses a PostgreSQL advisory lock, so only one migrator should apply migrations at a time.

## Application rollback

If the new application revision is faulty but the database schema is backward-compatible:

1. stop or drain the faulty revision,
2. deploy the last known-good application revision,
3. verify `/health` and `/ready`,
4. check `/api/admin/operations/health-summary`,
5. verify queue/dead-letter and fulfillment-recovery counts,
6. keep the newer forward-compatible schema in place.

Do not automatically reverse migrations solely because application code was rolled back.

## Schema-incompatible incident

If the database is not compatible with the last known-good application:

1. prevent further writes where possible,
2. take a current backup if the database remains reachable,
3. evaluate whether a forward repair migration can restore compatibility,
4. prefer the forward repair when canonical data can be preserved,
5. use managed point-in-time recovery only when forward repair cannot safely recover the system,
6. restore to a new database/branch first and verify it before switching production traffic.

## Database outage or corruption

1. Confirm the incident is database-side rather than application/network-side using `/ready`.
2. Stop nonessential background processors that could amplify retries.
3. Use the managed database provider's recovery/PITR procedure.
4. Restore to an isolated recovery target when possible.
5. Validate migration ledger, canonical tables, and key row counts.
6. Run reconciliation:
   - financial reconciliation,
   - notification/webhook dead-letter review,
   - blocked/recovery-required fulfillment review,
   - connector health review.
7. Switch traffic only after readiness and reconciliation are acceptable.
8. Preserve incident timestamps, restored revision, recovery point, and operator actions in the incident record.

## Operational health after recovery

After any recovery, inspect:

`GET /api/admin/operations/health-summary`

Pay particular attention to:

- overdue workflow deadlines,
- critical/open exceptions,
- dead or retrying notification deliveries,
- dead or retrying webhooks,
- degraded integration connections,
- blocked fulfillment plans,
- fulfillment plans requiring recovery,
- latest applied schema migration.

A database being reachable is necessary but not sufficient to declare recovery complete.

## Recovery evidence to retain

For a production recovery or scheduled recovery drill, retain:

- backup timestamp,
- database/provider recovery point,
- source application revision,
- restored application revision,
- latest migration before and after restore,
- backup/restore command or provider operation record,
- restore verification results,
- reconciliation summary,
- duration to restore service,
- any data-loss window,
- follow-up repair actions.

Never place credentials, raw connection strings, signing secrets, customer data, or payment-provider secrets in GitHub issues, pull requests, or the runbook.
