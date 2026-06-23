-- Arco session model v2 — group runs into pages
--
-- Hierarchy:
--   sessions (one per browser tab — sessionStorage)
--     └─ pages (one per URL visit, e.g. /?q=cyclists)
--         └─ runs (one per /api/generate call: initial + each follow-up click)
--
-- Existing `generated_pages` table is repurposed as `runs`. Columns added:
--   page_id            — groups runs belonging to the same URL visit
--   page_url           — the ?q= URL the run was generated for
--   run_index          — 0 for initial run, 1..N for follow-up clicks
--   parent_run_id      — the run whose follow-up chip triggered this run
--   follow_up_options  — JSON array of the follow-up chips shown to the user
--   follow_up_label    — label of the specific chip the user clicked (for this run)

ALTER TABLE generated_pages ADD COLUMN page_id TEXT;
ALTER TABLE generated_pages ADD COLUMN page_url TEXT;
ALTER TABLE generated_pages ADD COLUMN run_index INTEGER DEFAULT 0;
ALTER TABLE generated_pages ADD COLUMN parent_run_id TEXT;
ALTER TABLE generated_pages ADD COLUMN follow_up_options TEXT;
ALTER TABLE generated_pages ADD COLUMN follow_up_label TEXT;

CREATE INDEX IF NOT EXISTS idx_runs_page_id ON generated_pages(page_id);
CREATE INDEX IF NOT EXISTS idx_runs_parent ON generated_pages(parent_run_id);

-- Backfill page_id for existing rows — treat each existing row as its own page.
-- Follow-up rows won't be grouped retroactively (we don't have the URL/navigation link),
-- but new runs created after this migration will group correctly.
UPDATE generated_pages SET page_id = id WHERE page_id IS NULL;
