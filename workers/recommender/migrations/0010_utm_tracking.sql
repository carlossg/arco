-- Arco UTM campaign tracking — adds campaign attribution columns to page_events
-- so traffic can be attributed to a marketing campaign (utm_source/medium/campaign),
-- not just to the internal referrer_path.

ALTER TABLE page_events ADD COLUMN utm_source TEXT;
ALTER TABLE page_events ADD COLUMN utm_medium TEXT;
ALTER TABLE page_events ADD COLUMN utm_campaign TEXT;

CREATE INDEX IF NOT EXISTS idx_events_utm_campaign ON page_events(utm_campaign, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_utm_source ON page_events(utm_source, created_at DESC);
