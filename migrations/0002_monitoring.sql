ALTER TABLE sources ADD COLUMN last_checked_at TEXT;
ALTER TABLE sources ADD COLUMN last_check_error TEXT;
CREATE TABLE IF NOT EXISTS monitoring_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_cron_at TEXT,
  last_cron_error TEXT
);
INSERT OR IGNORE INTO monitoring_state (id) VALUES (1);
