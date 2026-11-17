CREATE TABLE IF NOT EXISTS sources (
 id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('github','rss')),
 name TEXT NOT NULL, url TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
 post_x INTEGER NOT NULL DEFAULT 1, post_instagram INTEGER NOT NULL DEFAULT 0,
 default_image_url TEXT, etag TEXT, last_modified TEXT, initialized INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS events (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id),
 external_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
 url TEXT NOT NULL, image_url TEXT, detected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(source_id,external_id)
);
CREATE TABLE IF NOT EXISTS deliveries (
 id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id),
 platform TEXT NOT NULL CHECK(platform IN ('x','instagram')),
 text TEXT NOT NULL, image_url TEXT, status TEXT NOT NULL DEFAULT 'pending_review'
 CHECK(status IN ('pending_review','scheduled','processing','published','failed','unknown','skipped')),
 attempts INTEGER NOT NULL DEFAULT 0, scheduled_at TEXT,
 remote_id TEXT, remote_url TEXT, last_error TEXT,
 claimed_at TEXT, published_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(event_id,platform)
);
CREATE INDEX IF NOT EXISTS idx_deliveries_due ON deliveries(status,scheduled_at);
CREATE INDEX IF NOT EXISTS idx_events_source ON events(source_id,detected_at);
