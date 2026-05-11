-- Track server-side eval orchestration progress via Cloudflare Queue.
-- completed_queries increments atomically per message (success or failure).
-- phase transitions: pending → generating → judging → complete | error

ALTER TABLE eval_runs ADD COLUMN completed_queries INTEGER DEFAULT 0;
ALTER TABLE eval_runs ADD COLUMN phase TEXT DEFAULT 'pending';
ALTER TABLE eval_runs ADD COLUMN last_activity_at INTEGER;
