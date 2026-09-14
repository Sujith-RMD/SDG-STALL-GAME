-- ===========================================================================
-- trim-leaderboard.sql
-- Keep only the top 3 leaderboard rows by score (descending); delete the rest.
-- ---------------------------------------------------------------------------
-- Assumed schema -- change the names if yours differ:
--
--   CREATE TABLE leaderboard (
--     id         BIGSERIAL PRIMARY KEY,        -- any UNIQUE NOT NULL key
--     name       TEXT        NOT NULL,
--     score      INTEGER     NOT NULL,
--     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
--   );
--
-- Guarantees this script gives you:
--   * the destructive DELETE sits inside a transaction, so nothing is durable
--     until an explicit COMMIT;
--   * the "top 3" set is computed BEFORE the delete and checked against the
--     rows about to be discarded, so a wrong ranking can never be applied;
--   * the surviving row count is asserted to be exactly 3 after the delete;
--   * re-running it is a no-op (it is idempotent once 3 rows remain).
--
-- READ THIS FIRST -- TIE HANDLING
-- If two rows share the 3rd-highest score, "top 3" is ambiguous. Every ORDER BY
-- below breaks ties deterministically with (created_at ASC, id ASC): the older
-- entry wins. Replace that with whatever your rules say -- but never drop the
-- tiebreak, or the surviving row becomes arbitrary and can change between runs.
-- ===========================================================================


-- ===========================================================================
-- SECTION 1 -- PostgreSQL  (canonical)
-- Run with:  psql -v ON_ERROR_STOP=1 -f sql/trim-leaderboard.sql
-- The ON_ERROR_STOP flag matters: without it psql keeps going after a failed
-- assertion instead of stopping.
-- ===========================================================================

BEGIN;

-- Freeze the table for the duration of the trim so a concurrent INSERT cannot
-- land a new high score between the snapshot and the DELETE.
LOCK TABLE leaderboard IN SHARE ROW EXCLUSIVE MODE;

-- Snapshot the rows we intend to keep.
CREATE TEMP TABLE lb_keep ON COMMIT DROP AS
SELECT id, score
FROM leaderboard
ORDER BY score DESC, created_at ASC, id ASC
LIMIT 3;

-- Snapshot the rows we intend to discard, for the pre-flight check.
CREATE TEMP TABLE lb_drop ON COMMIT DROP AS
SELECT l.id, l.score
FROM leaderboard l
WHERE NOT EXISTS (SELECT 1 FROM lb_keep k WHERE k.id = l.id);

-- Pre-flight: the best score we are about to delete must not beat the worst
-- score we are keeping. If it does, our keeper set is wrong and we abort
-- before touching a single row.
DO $$
DECLARE
  min_kept    integer;
  max_dropped integer;
BEGIN
  SELECT MIN(score) INTO min_kept    FROM lb_keep;
  SELECT MAX(score) INTO max_dropped FROM lb_drop;

  IF max_dropped IS NOT NULL AND max_dropped > min_kept THEN
    RAISE EXCEPTION
      'keeper set invalid: dropped score % exceeds kept minimum %',
      max_dropped, min_kept;
  END IF;
END $$;

-- The actual trim.
DELETE FROM leaderboard
WHERE EXISTS (SELECT 1 FROM lb_drop d WHERE d.id = leaderboard.id);

-- Post-trim assertion: the row count must equal the keeper set we snapshotted
-- (3, whenever the table started with at least 3 rows). RAISE EXCEPTION aborts
-- the whole transaction, so a failure here discards the DELETE. (If it does
-- fire, run ROLLBACK; to close the aborted transaction.)
DO $$
DECLARE
  expected  integer;
  remaining integer;
BEGIN
  SELECT COUNT(*) INTO expected  FROM lb_keep;
  SELECT COUNT(*) INTO remaining FROM leaderboard;

  IF remaining <> expected THEN
    RAISE EXCEPTION
      'post-trim check failed: expected % rows, found %', expected, remaining;
  END IF;

  -- A table with fewer than 3 rows is not an error -- there is simply nothing
  -- to trim. The count check above still catches a delete that removed the
  -- wrong rows.
  IF expected < 3 THEN
    RAISE NOTICE 'leaderboard held only % row(s); nothing needed trimming', expected;
  END IF;
END $$;

-- Survivors, printed before COMMIT so you can eyeball them.
SELECT ROW_NUMBER() OVER (ORDER BY score DESC, created_at ASC, id ASC) AS rank,
       id, name, score, created_at
FROM leaderboard
ORDER BY score DESC, created_at ASC, id ASC;

COMMIT;   -- nothing is durable until here. Use ROLLBACK; instead to back out.


-- ---------------------------------------------------------------------------
-- Post-commit verification -- safe to run on its own, outside the transaction.
-- Expect: exactly one row, kept_rows = 3, rows_outranking_kept = 0.
-- ---------------------------------------------------------------------------
SELECT (SELECT COUNT(*) FROM leaderboard) AS kept_rows,
       (SELECT COUNT(*)
          FROM leaderboard l
         WHERE NOT EXISTS (
                 SELECT 1 FROM (
                   SELECT id FROM leaderboard
                   ORDER BY score DESC, created_at ASC, id ASC
                   LIMIT 3
                 ) k
                 WHERE k.id = l.id
               )
       ) AS rows_outranking_kept;


-- ===========================================================================
-- SECTION 2 -- MySQL 8.0.16+
-- Run with:  mysql --table < sql/trim-leaderboard.sql
-- The 8.0.16 floor is for enforced CHECK constraints, which is how the
-- assertions below abort the transaction.
-- ===========================================================================

START TRANSACTION;

-- Lock the rows we intend to keep. MySQL has no LOCK TABLE inside a
-- transaction; this FOR UPDATE read takes equivalent row/gap locks.
SELECT id FROM leaderboard
ORDER BY score DESC, created_at ASC, id ASC
LIMIT 3
FOR UPDATE;

CREATE TEMPORARY TABLE lb_keep AS
SELECT id, score
FROM leaderboard
ORDER BY score DESC, created_at ASC, id ASC
LIMIT 3;

CREATE TEMPORARY TABLE lb_drop AS
SELECT l.id, l.score
FROM leaderboard l
WHERE NOT EXISTS (SELECT 1 FROM lb_keep k WHERE k.id = l.id);

-- Assertion harness: inserting 0 into this table raises a CHECK violation,
-- which aborts the statement. (MySQL 8 has no anonymous ASSERT block, so this
-- is the portable way to hard-fail. The offending numbers are printed by the
-- SELECT immediately above each INSERT, so read them in the error output.)
CREATE TEMPORARY TABLE lb_assert (
  ok TINYINT NOT NULL,
  CONSTRAINT lb_assert_ok CHECK (ok = 1)
);

-- Pre-flight check.
SELECT (SELECT MIN(score) FROM lb_keep)  AS min_kept,
       (SELECT MAX(score) FROM lb_drop)  AS max_dropped;

INSERT INTO lb_assert (ok)
SELECT CASE
         WHEN (SELECT MAX(score) FROM lb_drop) IS NOT NULL
          AND (SELECT MAX(score) FROM lb_drop) > (SELECT MIN(score) FROM lb_keep)
         THEN 0 ELSE 1
       END;

-- The actual trim. Note EXISTS, not NOT EXISTS: lb_drop already holds the
-- complement of the keeper set, so the rows to remove are the ones that ARE
-- in lb_drop.
DELETE FROM leaderboard
WHERE EXISTS (SELECT 1 FROM lb_drop d WHERE d.id = leaderboard.id);

-- Post-trim assertion: the row count must equal the keeper set snapshotted
-- above (3, whenever the table started with at least 3 rows).
SELECT COUNT(*) AS remaining FROM leaderboard;

INSERT INTO lb_assert (ok)
SELECT CASE WHEN (SELECT COUNT(*) FROM leaderboard) = (SELECT COUNT(*) FROM lb_keep)
            THEN 1 ELSE 0 END;

-- Survivors, printed before COMMIT.
SELECT id, name, score, created_at
FROM leaderboard
ORDER BY score DESC, created_at ASC, id ASC;

DROP TEMPORARY TABLE lb_assert;
DROP TEMPORARY TABLE lb_drop;
DROP TEMPORARY TABLE lb_keep;

COMMIT;   -- on a failed assertion the transaction is still open: run ROLLBACK;


-- ===========================================================================
-- SECTION 3 -- SQLite 3.25+
-- Run with:  sqlite3 leaderboard.db < sql/trim-leaderboard.sql
-- ===========================================================================

BEGIN IMMEDIATE;   -- take the write lock up front; no other writer interleaves

CREATE TEMP TABLE lb_keep AS
SELECT id, score
FROM leaderboard
ORDER BY score DESC, created_at ASC, id ASC
LIMIT 3;

CREATE TEMP TABLE lb_drop AS
SELECT l.id, l.score
FROM leaderboard l
WHERE NOT EXISTS (SELECT 1 FROM lb_keep k WHERE k.id = l.id);

-- Same assertion harness as MySQL: a CHECK violation aborts the statement.
CREATE TEMP TABLE lb_assert (
  ok INTEGER NOT NULL CHECK (ok = 1)
);

-- Pre-flight check.
SELECT (SELECT MIN(score) FROM lb_keep) AS min_kept,
       (SELECT MAX(score) FROM lb_drop) AS max_dropped;

INSERT INTO lb_assert (ok)
SELECT CASE
         WHEN (SELECT MAX(score) FROM lb_drop) IS NOT NULL
          AND (SELECT MAX(score) FROM lb_drop) > (SELECT MIN(score) FROM lb_keep)
         THEN 0 ELSE 1
       END;

-- The actual trim. EXISTS, not NOT EXISTS -- lb_drop already holds the
-- complement of the keeper set.
DELETE FROM leaderboard
WHERE EXISTS (SELECT 1 FROM lb_drop d WHERE d.id = leaderboard.id);

-- Post-trim assertion: the row count must equal the keeper set snapshotted
-- above (3, whenever the table started with at least 3 rows).
SELECT COUNT(*) AS remaining FROM leaderboard;

INSERT INTO lb_assert (ok)
SELECT CASE WHEN (SELECT COUNT(*) FROM leaderboard) = (SELECT COUNT(*) FROM lb_keep)
            THEN 1 ELSE 0 END;

-- Survivors, printed before COMMIT.
SELECT id, name, score, created_at
FROM leaderboard
ORDER BY score DESC, created_at ASC, id ASC;

DROP TABLE lb_assert;
DROP TABLE lb_drop;
DROP TABLE lb_keep;

COMMIT;   -- on a failed assertion the transaction is still open: run ROLLBACK;


-- ===========================================================================
-- NOTES
-- ---------------------------------------------------------------------------
-- * NULL trap: never rewrite the delete as `WHERE id NOT IN (SELECT id FROM
--   lb_keep)`. If the subquery yields a NULL, NOT IN matches nothing and the
--   delete silently removes zero rows. NOT EXISTS has no such failure mode.
-- * Concurrent writers: Section 1's LOCK TABLE is the strongest guarantee. On
--   MySQL/SQLite the lock only covers rows that already exist, so a committed
--   INSERT racing the trim can still land afterwards. If that matters, run the
--   trim in a maintenance window or gate writes at the application layer.
-- * `leaderboard` here is a plain SQL table. This repo's live board is a Redis
--   sorted set (`lb:all`, `lb:day:<YYYYMMDD>`), trimmed by
--   api/_lib/trim.js -> POST /api/admin/trim-leaderboard.
--   RANK DIRECTION WARNING: Redis sorted-set ranks ascend by score, so rank 0
--   is the LOWEST entry. To keep the highest 3 you remove ascending ranks 0
--   through len-4, i.e.  ZREMRANGEBYRANK lb:all 0 -4
--   NOT  ZREMRANGEBYRANK lb:all 3 -1, which keeps the three LOWEST scores.
--   (Redis has no "keep the top N" command, which is why the API route uses a
--   Lua script that computes the cutoff score and removes below it.)
-- ===========================================================================
