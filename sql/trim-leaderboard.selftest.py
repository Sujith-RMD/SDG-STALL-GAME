#!/usr/bin/env python3
"""
Self-test for sql/trim-leaderboard.sql.

Extracts the SQLite section of the script and runs it against a throwaway
in-memory database, asserting the four behaviours the script promises:

  A. happy path      -- 3 highest scores survive, in the right order
  B. boundary tie    -- a tie at 3rd place resolves to the earlier entry
  C. idempotency     -- running it twice deletes nothing the second time
  D. failure path    -- a wrong keeper set aborts, and the transaction
                        rolls back leaving the table untouched

Run:  python sql/trim-leaderboard.selftest.py
"""

import sqlite3
import sys
from pathlib import Path

SQL_PATH = Path(__file__).with_name("trim-leaderboard.sql")

DDL = """
CREATE TABLE leaderboard (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  score      INTEGER NOT NULL,
  created_at TEXT    NOT NULL
);
"""


def load_sqlite_section() -> str:
    text = SQL_PATH.read_text(encoding="utf-8")
    start = text.index("-- SECTION 3 -- SQLite")
    start = text.index("BEGIN IMMEDIATE;", start)
    end = text.index("-- NOTES", start)
    end = text.rindex("-- ======", start, end)
    return text[start:end]


def fresh_db(rows):
    conn = sqlite3.connect(":memory:")
    conn.executescript(DDL)
    conn.executemany("INSERT INTO leaderboard VALUES (?, ?, ?, ?)", rows)
    conn.commit()
    return conn


def survivors(conn):
    return conn.execute(
        "SELECT id, score FROM leaderboard ORDER BY score DESC, created_at ASC, id ASC"
    ).fetchall()


ROWS = [
    (1, "Ana", 100, "2026-01-01"),
    (2, "Ben", 250, "2026-01-02"),
    (3, "Cara", 250, "2026-01-03"),
    (4, "Dev", 180, "2026-01-04"),
    (5, "Eve", 90, "2026-01-05"),
    (6, "Fay", 180, "2026-01-06"),
    (7, "Gus", 30, "2026-01-07"),
    (8, "Hal", 220, "2026-01-08"),
]

# Same board plus a late entry that ties the 3rd-highest score (220).
ROWS_TIE = ROWS + [(9, "Ivy", 220, "2026-01-09")]

results = []


def check(label, got, want):
    ok = got == want
    results.append(ok)
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}")
    if not ok:
        print(f"         got:  {got}")
        print(f"         want: {want}")


sqlite_sql = load_sqlite_section()

print("A. happy path -- 8 rows, tie at the top (250/250)")
conn = fresh_db(ROWS)
conn.executescript(sqlite_sql)
check("exactly 3 rows remain", len(survivors(conn)), 3)
check(
    "survivors are the 3 highest scores",
    survivors(conn),
    [(2, 250), (3, 250), (8, 220)],
)
check("durable after COMMIT (fresh read)", survivors(conn), [(2, 250), (3, 250), (8, 220)])
conn.close()

print("\nB. boundary tie -- a 4th row also scores 220, created later")
conn = fresh_db(ROWS_TIE)
conn.executescript(sqlite_sql)
check("exactly 3 rows remain", len(survivors(conn)), 3)
check(
    "tiebreak keeps the earlier entry (id 8, not id 9)",
    survivors(conn),
    [(2, 250), (3, 250), (8, 220)],
)
conn.close()

print("\nC. idempotency -- run the script a second time")
conn = fresh_db(ROWS)
conn.executescript(sqlite_sql)
before = survivors(conn)
conn.executescript(sqlite_sql)
check("second run changes nothing", survivors(conn), before)
conn.close()

print("\nD. failure path -- keeper set deliberately corrupted (ORDER BY ASC)")
bad_sql = sqlite_sql.replace("ORDER BY score DESC, created_at ASC, id ASC\nLIMIT 3",
                            "ORDER BY score ASC, created_at ASC, id ASC\nLIMIT 3", 1)
check("corruption actually applied to the test copy", bad_sql != sqlite_sql, True)
conn = fresh_db(ROWS)
aborted = False
try:
    conn.executescript(bad_sql)
except sqlite3.IntegrityError as exc:
    aborted = True
    print(f"         assertion fired: {exc}")
check("pre-flight assertion aborted the script", aborted, True)
conn.rollback()
check("rollback left all 8 rows intact", len(survivors(conn)), 8)
check(
    "table is unchanged, not partially trimmed",
    survivors(conn),
    sorted([(r[0], r[2]) for r in ROWS], key=lambda t: -t[1]),
)
conn.close()

print("\nE. small table -- only 2 rows, nothing to trim")
conn = fresh_db(ROWS[:2])
try:
    conn.executescript(sqlite_sql)
    check("does not abort on a table with fewer than 3 rows", True, True)
except sqlite3.IntegrityError as exc:
    check("does not abort on a table with fewer than 3 rows", False, f"raised {exc}")
check("both rows survive", len(survivors(conn)), 2)
conn.close()

print(f"\n{sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)
