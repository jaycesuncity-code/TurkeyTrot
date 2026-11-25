-- Turkey Trot 5K schema. Safe to run more than once.
CREATE TABLE IF NOT EXISTS runners (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  bib         INTEGER UNIQUE,
  first_name  TEXT NOT NULL,
  last_name   TEXT NOT NULL DEFAULT '',
  age_group   TEXT NOT NULL CHECK (age_group IN ('youngster', 'unc')),
  finish_ms   INTEGER,
  stamp_id    TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS finish_stamps (
  id          TEXT PRIMARY KEY,
  elapsed_ms  INTEGER NOT NULL,
  runner_id   INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS race_state (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  start_at_ms  INTEGER,
  end_at_ms    INTEGER,
  status       TEXT NOT NULL DEFAULT 'idle',
  updated_at   INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO race_state (id, start_at_ms, end_at_ms, status, updated_at) VALUES (1, NULL, NULL, 'idle', 0);

CREATE INDEX IF NOT EXISTS idx_stamps_runner ON finish_stamps (runner_id);
CREATE INDEX IF NOT EXISTS idx_runners_stamp ON runners (stamp_id);
