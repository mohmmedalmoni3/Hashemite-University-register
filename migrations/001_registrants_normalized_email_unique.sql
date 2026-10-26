-- Email normalization is also applied in server.js before every INSERT.
-- Preflight: this query must return no rows before creating the index.
SELECT lower(btrim(email)) AS normalized_email, count(*) AS duplicate_count
FROM registrants
GROUP BY lower(btrim(email))
HAVING count(*) > 1;

-- Run this statement outside a transaction (psql supports this by default).
-- CONCURRENTLY keeps the existing table available while the index is built.
-- If preflight found duplicates, review them manually; this migration deletes
-- or rewrites no registration data.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS registrants_email_normalized_unique
  ON registrants (lower(btrim(email)));
