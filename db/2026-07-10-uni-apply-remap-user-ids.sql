-- ─────────────────────────────────────────────────────────────────────────────
-- ONE-TIME MIGRATION — run once in the Supabase SQL editor BEFORE deploying
-- the uni-apply IDOR fix (getUser now uses access_codes.id as user_id).
--
-- Old scheme: user_id = numeric digits of the student code ("IB0007" → 7).
-- New scheme: user_id = access_codes.id of the verified code row.
--
-- This remaps existing uni-apply rows old→new. It is SAFE TO RUN in every
-- case:
--   • No uni-apply data yet            → updates 0 rows, done.
--   • Data exists, ids already match   → skipped by the d.old_id <> d.new_id filter.
--   • Data exists, ids differ          → remapped, skipping any collision
--     (a row already present under the new id is left untouched).
-- Run it twice by accident and the second run is a no-op.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

WITH map AS (
  SELECT
    NULLIF(regexp_replace(code, '\D', '', 'g'), '')::bigint AS old_id,
    id                                                      AS new_id
  FROM access_codes
),
dedup AS (
  -- If two codes share the same digit string (e.g. IBH-1234-5678 issued twice
  -- with different prefixes), the old id is ambiguous — leave those rows alone.
  SELECT old_id, MIN(new_id) AS new_id
  FROM map
  WHERE old_id IS NOT NULL
  GROUP BY old_id
  HAVING COUNT(*) = 1
)
UPDATE uni_apply_profiles p
SET user_id = d.new_id
FROM dedup d
WHERE p.user_id = d.old_id
  AND d.old_id <> d.new_id
  AND NOT EXISTS (SELECT 1 FROM uni_apply_profiles x WHERE x.user_id = d.new_id);

WITH map AS (
  SELECT NULLIF(regexp_replace(code, '\D', '', 'g'), '')::bigint AS old_id, id AS new_id
  FROM access_codes
),
dedup AS (
  SELECT old_id, MIN(new_id) AS new_id FROM map
  WHERE old_id IS NOT NULL GROUP BY old_id HAVING COUNT(*) = 1
)
UPDATE uni_apply_answers a
SET user_id = d.new_id
FROM dedup d
WHERE a.user_id = d.old_id
  AND d.old_id <> d.new_id
  AND NOT EXISTS (
    SELECT 1 FROM uni_apply_answers x
    WHERE x.user_id = d.new_id AND x.question_id = a.question_id
  );

WITH map AS (
  SELECT NULLIF(regexp_replace(code, '\D', '', 'g'), '')::bigint AS old_id, id AS new_id
  FROM access_codes
),
dedup AS (
  SELECT old_id, MIN(new_id) AS new_id FROM map
  WHERE old_id IS NOT NULL GROUP BY old_id HAVING COUNT(*) = 1
)
UPDATE uni_apply_achievements t
SET user_id = d.new_id
FROM dedup d
WHERE t.user_id = d.old_id
  AND d.old_id <> d.new_id;

COMMIT;

-- Afterwards, sanity check (should return 0 rows = no orphaned old-style ids):
-- SELECT user_id FROM uni_apply_profiles
-- WHERE user_id NOT IN (SELECT id FROM access_codes) AND user_id < 999900;
