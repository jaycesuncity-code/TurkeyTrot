-- Change counter: bumped on every write so phones only download data when something changed.
ALTER TABLE race_state ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
