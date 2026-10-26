# IEEE Day 2026 registration service

Node.js serves the registration page and admin dashboard. PostgreSQL records are stored in Neon. The registration route validates input on the server, writes one parameterized insert, and relies on unique database indexes to resolve concurrent duplicates.

## Render environment variables

Set these on the Render service; never commit real values:

- `DATABASE_URL`: Neon **pooled** connection string; its hostname must contain `-pooler` and SSL must be enabled. Production startup rejects a direct endpoint.
- `ADMIN_USERNAME` and `ADMIN_PASSWORD`: unique dashboard credentials.
- `SESSION_SECRET`: at least 32 characters; the Render Blueprint generates this value.
- `NODE_ENV=production` and `PORT` are handled by Render / `render.yaml`.
- `MIGRATION_DATABASE_URL`: optional local shell variable for a one-off Neon **direct** connection. This is not read by runtime code and must not be set as the service's `DATABASE_URL`.

The `pg` pool is created once per Node isolate and reused, with a maximum of four connections, bounded connection/query timeouts, and brief retries for transient Neon wake/connect errors. Email addresses are trimmed and lowercased before insert. Phone, email, and device uniqueness are enforced in PostgreSQL. There is no confirmation-email sender in this repository.

## Email index migration

The app already creates a case-insensitive unique index at startup. The migration adds a stricter unique expression index on `lower(btrim(email))`, so whitespace variants are covered too. It does not delete or rewrite existing records.

1. Use the read-only preflight query in `migrations/001_registrants_normalized_email_unique.sql`. It must return no rows. If it finds duplicates, review and resolve those manually before continuing.
2. From a trusted shell, set `MIGRATION_DATABASE_URL` to Neon's direct (non-pooled) connection string and run the `CREATE UNIQUE INDEX CONCURRENTLY` statement from the same file with `psql`. Do not wrap that command in a transaction. Keep this direct URL out of Render runtime variables.

Example in PowerShell:

```powershell
$env:MIGRATION_DATABASE_URL = "<Neon direct URL>"
psql $env:MIGRATION_DATABASE_URL -c "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS registrants_email_normalized_unique ON registrants (lower(btrim(email)));"
```

## Deploy with Render

The repository uses a custom Node HTTP server and `render.yaml`; it is currently configured for Render, not Vercel.

1. Set the pooled Neon URL and admin secrets in Render.
2. Apply the email migration above before launching a registration event.
3. Push the approved change to `main`; Render deploys from the connected GitHub repository.
4. Check `/api/healthz` before the event to wake the service and Neon compute. It returns only service status.

The Blueprint uses Render's free web-service plan, which can sleep while idle and delay the first request while waking. Neon free-tier compute and storage have separate quotas and limits. Check both dashboards and consider keeping the service/compute warm during the event if the plan permits.

## Local-only burst test

The k6 test is hard-coded to reject remote hosts. It issues 400 concurrent requests: 320 unique email addresses and 80 duplicates. Start a local copy of the service pointed at a **disposable local/test database**, then run:

```powershell
$env:BASE_URL = "http://127.0.0.1:10000"
$env:RUN_ID = "event-dry-run-01"
npm run load-test
```

Never point the local service at production Neon data. After a run, inspect and clean only the test database using `scripts/cleanup-registration-load-test.sql`. k6 reports created rows, expected duplicate rejections, unexpected responses, HTTP failure rate, and p95 latency. A 400-request test is not a substitute for checking Render's plan concurrency limits or Neon quota.

## Security

- Admin endpoints require a signed, HTTP-only, same-site session cookie.
- Rate limiting allows 1,000 registration attempts per IP per hour to accommodate shared event Wi-Fi; its counter is in-memory and scoped to a Node process.
- Error logs contain only route, status, and error code. Request bodies and personal data are never logged.
- Do not commit secrets. Dashboard export is available only after admin sign-in.
