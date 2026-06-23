# Recommender Code Review — Tracking

Base audit: 2026-04-23. Items 1–6 shipped in PR #20 (commit `d89d216`).
Update the checkboxes as items land. Keep item numbers stable so they remain
quotable in PRs and issues.

---

## Real bugs

- [x] **1. `ctx.rag.articles` is read but never written.** `rag-content.js:65`
  writes `ctx.rag.guides`, `build-recommender-prompt.js:18` reads
  `ctx.rag.guides` (correct), but `llm-generate.js:577,581` reads
  `ctx.rag.articles`. The debug payload's `articles.count` and `articles.items`
  are permanently zero/empty. Either rename one side or fix the reader.
  — Fixed in PR #20 by replacing `articles` with the five real types the RAG
  step actually emits: `guides`, `experiences`, `comparisons`, `tools`,
  `heroImages`. Debug panel and admin view updated.

- [x] **2. `intentType` stored in D1 is always undefined.**
  `intent-classify.js:135` writes `ctx.intent = { type, confidence, journeyStage }`.
  `llm-generate.js:333` reads `ctx.rag?.intentClassification?.intentType` — that
  path doesn't exist. The `generated_pages.intent_type` column (and every
  admin-UI "intent" badge derived from it) is silently broken. Change to
  `ctx.intent?.type`. — Fixed in PR #20.

- [x] **3. Suggestion-type set has 6 values but only 2 survive.**
  `llm-generate.js:190` lists `['explore','compare','recipe','buy','quiz','customize']`
  and `processSuggestions` (line 247) accepts all 6 and has a `'buy'` branch
  (line 249). Downstream at `llm-generate.js:513` the result is filtered to
  `explore | compare` only. The buy enrichment and the 4 other types are dead on
  the recommender flow. Collapse to a single `ALLOWED_SUGGESTION_TYPES =
  ['explore','compare']` constant and drop the buy branch. — Fixed in PR #20
  (now `LLM_SUGGESTION_TYPES`); server-injected `buy` CTA for the primary
  product is retained.

## Confirmed dead code

- [x] **4. `keywordMatchGuides()` stub.** `context.js:247` always returns `[]`;
  the three callers (lines 315, 331, 384) read a field that's always empty.
  Either delete or rewrite. — Deleted in PR #20 along with its three callers.

- [x] **5. `getAllRecipes` / `getAllAccessories` exported, never imported.**
  `context.js:400,407`. — Deleted in PR #20 along with their JSON imports.

- [x] **6. `buildPersonalizationBanner(main)` defined, never called.**
  `scripts/scripts.js:57`. — Deleted in PR #20.

## Client–server drift

- [x] **7. Duplicate session-id generator.** `scripts/scripts.js:240`
  `getOrCreateSessionId()` writes key `arco-session-id` to sessionStorage;
  `scripts/session-context.js:59,169` has its own `sessionId` on the context
  object. They're independent — a session-context reset wouldn't clear the
  other. Pick one. — Deleted `getOrCreateSessionId` and the `arco-session-id`
  key; both call sites now use `SessionContextManager.getSessionId()`.

- [x] **8. Duplicate `BLOCK_ALIASES` map.** `scripts/scripts.js:99` and
  `blocks/admin/admin.js:25` define the same alias table. If someone adds a new
  LLM block name and only updates streaming, admin replay breaks. Move to a
  shared module. — Extracted to `scripts/block-aliases.js`, imported by both.

- [x] **9. Client generates `runId` that the server trusts blindly.**
  `scripts/scripts.js` and `speculative-engine.js` both mint UUIDs; worker
  `storage.js` inserts whatever the client sent as the D1 primary key. Nothing
  validates shape or collisions. Either generate server-side or validate. —
  Worker now validates `runId`, `pageId`, `parentRunId`, `sessionId` against
  strict UUID regex; invalid values become `null` and the server mints its own
  in `saveGeneration`.

- [x] **10. Request-body whitelist.** Worker `index.js` validates only `query` +
  `sessionId` and forwards the rest. Adding a client field for an experiment
  silently works until something breaks. Document the accepted shape or
  whitelist. — New `workers/recommender/src/request-schema.js` parses the body
  against an explicit whitelist (query, sessionId, pageId, pageUrl, runId,
  parentRunId, speculative, flow, followUp, context) with per-field validation
  and size caps. Extra fields are silently dropped.

## Duplication worth collapsing

- [ ] **11. Three `escapeHtml`/`esc` implementations on the client:**
  `blocks/admin/admin.js:34`, `blocks/vectorize/vectorize.js:19`,
  `blocks/debug-panel/debug-panel.js:23`. And three on the worker side:
  `json-to-eds.js:13`, `da-persist.js:119`, `admin.js:420`. One shared util each
  side.

- [ ] **12. `da-persist.js` retry logic duplicated.** Three copies of the same
  "try, refresh token on 401, retry once" block (`createPage`, `triggerPreview`,
  `publishToLive`). Extract `withTokenRetry(fn, label)`.

- [x] **13. Four RAG step files are near-identical boilerplate.** `rag-faqs.js`,
  `rag-features.js`, `rag-products.js`, `rag-reviews.js` are ~14 lines each and
  follow the same "time it, call helper, slice" shape. Replace with a factory
  in `pipeline/steps/index.js`. — Collapsed into a single `rag-simple.js`
  that uses a `createSlicingStep({ key, defaultMax, fetch })` factory; the
  four standalone files are deleted.

- [x] **14. Time-format helpers re-implemented.** `formatMs`, `dur`, `ts`,
  `fmtInt`, `timingClass` appear in `debug-panel.js`, `admin.js`, and
  `vectorize.js`. Extract to `scripts/formatting.js`. — New
  `scripts/formatting.js` exports `formatTimestamp`, `formatDuration`,
  `formatInt`, `timingClass`; all three blocks import from it.

- [x] **15. Section-metadata processing duplicated.** Same logic in
  `scripts/scripts.js:342` (streamed) and `blocks/admin/admin.js:243` (stored
  replay). If style/metadata format evolves they drift. — Extracted to
  `scripts/section-metadata.js` `processSectionMetadata(section)`; both
  streaming and admin replay call it.

## Architecture / overlong files

- [ ] **16. `workers/recommender/src/admin.js` (788 lines)** bundles auth, data
  access, HTML SPA template, and route handlers. Split into `admin-auth.js`,
  `admin-api.js`, plus a separate HTML template. Also: the EDS `blocks/admin/`
  block now mirrors most of the SPA — decide which is canonical and delete the
  loser.

- [ ] **17. `src/images.js` (495 lines)** mixes image URL resolution, token
  expansion, and story/experience HTML rendering — three concerns, three files.

- [ ] **18. `src/context.js` (409 lines)** is a grab-bag: pipeline factory +
  persona matcher + product matcher + Vectorize search + comparison helpers.

- [ ] **19. `src/pipeline/steps/llm-generate.js` (698 lines)** holds the
  streaming parse, suggestion filter, dummy-bypass, title extraction,
  persistence glue — split at minimum the "parse / filter / enrich" layer from
  the streaming I/O.

- [ ] **20. `scripts/scripts.js` (983 lines)** mixes EDS decoration with
  recommender streaming + prefetch + SPA routing. Extracting a
  `recommender-page.js` would let the base framework file read like a normal
  EDS `scripts.js`.

## Inconsistencies / naming

- [x] **21. camelCase JS vs snake_case D1** — correctly mapped but in three
  places (`index.js:137`, `storage.js:95`, `admin.js:148`). A single DTO helper
  would keep them in sync. — New `rowToRunDto(r)` exported from `storage.js`
  is the single mapping; `handleAdminSession` in `admin.js` uses it to remove
  the inline per-field rename list.

- [x] **22. "intent" is overloaded.** `browsing-signals.js` emits rule-based
  `intent`, worker `intent-classify.js` emits a different `ctx.intent`, admin UI
  shows yet another `intent_type` column. Rename one or document the three
  layers. — Added docstring notes on both `browsing-signals.js` and
  `intent-classify.js` explaining the three distinct notions. Renaming would
  touch too many sites for the value; the comments make the distinction
  discoverable when reading either file.

- [x] **23. Pipeline step signatures differ.** Some take `(ctx, config)`, some
  `(ctx, config, env)`, `intentClassify` takes just `(ctx)`. Executor tolerates
  it but extension is brittle. — Every step now declares
  `async (ctx, config = {}, env = {}) => void`. Contract documented in
  `pipeline/executor.js` and `pipeline/steps/index.js`.

- [x] **24. Admin back-compat shim.** `admin.js` still handles pre-0002 rows via
  `r.page_id || r.id` and `WHERE page_id = ?1 OR (page_id IS NULL AND id = ?1)`.
  If migration 0002 has fully backfilled, delete the fallback; if not, gate it
  behind a comment with a removal date. — Removed both fallbacks (migration
  0002 backfills `page_id = id` for any remaining NULL rows, so the shim is
  unnecessary).

## Storage / schema gaps

- [x] **25. Admin UI doesn't render `run_index`, `follow_up_label`, or
  `parent_run_id`** — even though 0002 added them. The follow-up chain (which
  chip was clicked on which run) is invisible in the admin view. — The
  `blocks/admin/admin.js` Timeline tab now renders `run_index` as the
  numbered marker, `follow_up_type`/`follow_up_label` in the run header,
  `follow_up_options` as inert chips with a "↓ clicked" marker on the one
  that triggered the next run, and `parent_run_id` in the per-run details
  panel. (Most of this landed with the admin refactor; verified complete
  alongside items 21/24.)

- [ ] **26. KV key is still `page:{runId}`** (misnomer — it's a run payload).
  Comment at `storage.js:15` flags it as legacy. Either migrate or remove the
  apology.

- [ ] **27. `parent_run_id` has no FK constraint in 0002.** Orphan rows possible
  if a parent is ever deleted. Add `FOREIGN KEY(parent_run_id) REFERENCES
  generated_pages(id) ON DELETE CASCADE` in a new migration. — **Skipped**:
  SQLite (and therefore D1) doesn't support `ALTER TABLE ADD CONSTRAINT`, so
  adding an FK requires recreating the `generated_pages` table and copying
  data. Even then, FK enforcement in D1 requires `PRAGMA foreign_keys = ON`
  per connection, which isn't reliable from a worker. Keeping as a known
  limitation; application-level cleanup is cheaper than a risky table swap.

## Legacy / transitional

- [ ] **28. `da-persist.js:65`** carries an `S2S > legacy DA_TOKEN` fallback —
  document the deprecation or set a removal date.

- [ ] **29. `generate-images-firefly.js:352`** carries an "x-model-version for
  legacy image3 variants" shim — confirm if still relevant.

- [x] **30. `speculative-engine.js:1`** still credits Vitamix in the header —
  fine, but audit for any Vitamix-specific assumptions before treating it as
  canonical. — Header rewritten to describe the engine on its own terms; no
  Vitamix-specific logic found in the file.

---

## Recommended order of operations

- [x] **Phase 1 — bug fixes (half-day).** Items 1, 2, 3, 4, 5, 6. One-line or
  one-hunk changes with user-visible impact (broken debug payload, broken admin
  intent filter, dead UI branches). Shipped in PR #20.

- [ ] **Phase 2 — cleanup (half-day).** Items 7, 8, 11, 13, 14. Shared utils +
  RAG-step factory — contained, low-risk. (7, 8 done alongside 9/10; 13, 14
  done in phase 3 batch. Only item 11 remaining.)

- [ ] **Phase 3 — refactor (1–2 days).** Items 16, 17, 18, 19, 20. Splitting the
  four giants. Do one at a time, no interleaving.

- [ ] **Phase 4 — schema hygiene.** Items 24, 25, 26, 27 — a single migration +
  admin-UI pass.

Items 9, 10, 12, 15, 21, 22, 23, 28, 29, 30 are not bundled into a phase — pick
up opportunistically when touching adjacent code.
