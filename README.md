# Deployment and configuration

This project is a Node.js web service serving the registration site and dashboard. Registration records are stored in PostgreSQL (Neon) and the dashboard requires a signed-in administrator.

## Required Render secrets

Set these environment variables on the Render web service. Do not commit `.env` or paste secrets into chat:

- `DATABASE_URL`: copy the pooled connection string from Neon (enable SSL / `sslmode=require`).
- `ADMIN_USERNAME`: choose the dashboard username.
- `ADMIN_PASSWORD`: use a long, unique password.
- `SESSION_SECRET`: Render's Blueprint generates a value; it must contain at least 32 characters.
- `NODE_ENV=production` and `PORT` are handled by Render / `render.yaml`.

The app creates the `registrants` table and unique phone/email indexes at startup. Phone is canonicalized before storage; email uniqueness is case-insensitive. Database constraints enforce both rules even for simultaneous requests.

## Deploy with Render Blueprint

1. Create a GitHub repository with the contents of this `outputs` directory at the repository root (including `render.yaml`).
2. Create a PostgreSQL project on Neon and copy its pooled connection string. Keep the provider's SSL requirement enabled.
3. In Render, create a new Blueprint from the GitHub repository containing `render.yaml`.
4. At service setup, enter the Neon `DATABASE_URL` and the administrator username and password. Render generates `SESSION_SECRET` from the Blueprint.
5. After deploy, open the Render service URL. Verify `/api/healthz` returns `{"status":"ok"}`, submit a record, then sign in at `/admin.html`.

The included Blueprint uses Render's free web-service plan; free services may sleep when idle and wake on a subsequent request. For a continuously available registration campaign, choose a suitable paid service plan. Neon has separate database plan limits; check its dashboard before launching a large campaign.

## Security and data

- Registrations are public; the admin API requires a signed, HTTP-only, same-site session cookie.
- Dashboard export is available only after admin sign-in.
- Do not put real credentials in source files or this README.
- Manage Neon backups/retention and access through the Neon and Render dashboards.
