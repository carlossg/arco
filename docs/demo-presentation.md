


---

## Slide 1: Title

# Agentic Sites: Building Hyper Personalized Websites

- **What:** Intent-driven page generation, persona-based personalization, and proactive "For You" recommendations
- **Where:** AEM Edge Delivery Services (aem.live) + Google Cloud
- **How:** Gemini + open-source models, 28 custom blocks, a 257-page content corpus, and a 6-persona personalization engine

---

## Slide 2: The Problem We're Solving

- Users arrive with different goals: discover, compare, learn, buy, troubleshoot
- Static sites serve the same page to everyone
- Authors can't manually create a page for every possible question or persona
- **Solution:** Three layers of personalization working together:
  1. **Persona quiz** — identifies who you are and adapts the site in real time
  2. **Query generation** — creates a new page for any natural-language question
  3. **"For You" prefetch** — proactively generates a personalized page based on browsing behavior

---

## Slide 3: Three Generation Paths

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│  1. PERSONA QUIZ                                                    │
│     4 questions → 6 personas → hero, products, blog, nav adapt     │
│     Cookie-based, instant, no backend call                          │
│                                                                     │
│  2. QUERY GENERATION  (?q=...)                                      │
│     User types a question → intent classified → blocks generated    │
│     → page streams via SSE → auto-persists to AEM                  │
│                                                                     │
│  3. "FOR YOU" PREFETCH                                              │
│     After 2+ page visits, browsing signals synthesize a query →    │
│     background SSE pre-generates a page → "For You" nav link       │
│     renders instantly when clicked                                  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Slide 4: Architecture at a Glance

| Layer | Technology |
|-------|------------|
| **Frontend** | AEM Edge Delivery Services (28 blocks, scripts, styles) |
| **Personalization** | Assembly engine + quiz logic (6 personas, cookie-based) |
| **AI API** | Cloud Run — Recommender service (Express / TypeScript) |
| **Models** | Google Vertex AI — Gemini 3, 2.5, 2.0 families + Model Garden (Llama, Mistral, Gemma) |
| **Content corpus** | 257 JSON content files (products, guides, experiences, blog, tools, bundles) |
| **Brew Guide search** | Cloud Function Gen2 — Firestore Vector Search (text-embedding-005, cosine) |
| **Persistence** | Document Authoring (DA) API → aem.live preview & publish |
| **Analytics** | Cloud Function Gen2 — event tracking, session analytics, Firestore storage |

---

## Slide 5: Persona-Based Personalization

A 4-question quiz identifies one of **6 personas**:

| Persona | Adapts to |
|---------|-----------|
| **Morning Minimalist** | Simple setups, calm mornings, Primo/Nano |
| **Upgrader** | Ready to level up, Doppio/Studio comparisons |
| **Craft Barista** | Pro-level equipment, Studio Pro, advanced techniques |
| **Traveller** | Portable gear, Viaggio, travel guides |
| **Non-Barista** | One-touch simplicity, Automatico, zero learning curve |
| **Office Manager** | Volume equipment, Ufficio, ROI calculators |

**What changes per persona:**
- Homepage hero (headline, image, CTA)
- Product recommendations (ordering and selection)
- Blog feed (different articles surfaced)
- Experience CTA (archetype-specific messaging)
- Navigation (promoted/demoted links, persona-specific CTA)
- Personalization banner (slim top-of-page indicator)

---

## Slide 6: "For You" — Proactive Background Generation

After the user visits **2+ pages**, the system:

1. **Collects signals** passively (pages viewed, scroll depth, quiz answers, product filters, tab switches, video plays)
2. **Infers a profile** (products viewed, categories, journey stage, interests)
3. **Synthesizes a natural-language query** from the profile (e.g. *"I've been looking at the Primo and Doppio. Help me compare my options"*)
4. **Pre-generates a full page** via a background SSE stream to the recommender
5. **Shows a "For You" link** in the navigation that renders the pre-generated page instantly

The prefetch re-triggers when context changes significantly (new product viewed, journey stage changes, quiz taken, 2+ new page visits). Debounced to one prefetch per 30 seconds.

---

## Slide 7: Query-Driven Generation (?q=...)

| Parameter | URL | What it does |
|-----------|-----|--------------|
| **Query** | `?q=...` or `?query=...` | Full flow: session context, streaming, auto-persist |
| **Preset** | `&preset=production` | Override model preset (default: `production`) |

The AI classifies queries into **13 intent types** with journey stage scoring:

| Intent | Example |
|--------|---------|
| `discovery` | "What espresso machines do you have?" |
| `comparison` | "Primo vs Doppio" |
| `product-detail` | "Tell me about the Nano" |
| `use-case` | "Best machine for a small café" |
| `technique` | "How to pull the perfect shot" |
| `beginner` | "I'm new to espresso" |
| `upgrade` | "Upgrading from a Primo" |
| `gift` | "Gift for a coffee lover" |
| `support` | "My grinder is making a noise" |

Each query also gets a **journey stage** (`exploring`, `comparing`, `deciding`) that shapes block selection and follow-up suggestions.

---

## Slide 8: What Gets Generated — The Block Palette

The AI selects from **21 block types** and composes a page that matches the query:

- **Products:** product-detail, product-list, best-pick, comparison-table, feature-highlights, use-case-cards
- **Content:** hero, cards, columns, tabs, accordion, carousel, table, text
- **Interactive:** quiz, follow-up, quick-answer, support-triage
- **Media:** video, quote, testimonials
- **Utility:** budget-breakdown

**28 frontend blocks** (including header, footer, form, search, etc.) support these types. Block selection and order are driven by intent — no fixed templates.

---

## Slide 9: The Content Corpus

The AI draws from a **257-file content corpus** to ground its responses:

| Category | Content |
|----------|---------|
| **Products** | 12 machines/grinders: Primo, Doppio, Nano, Studio, Studio Pro, Ufficio, Viaggio, Automatico, Filtro, Preciso, Macinino, Zero |
| **Right for You** | Per-product personalized pages (10 variants) |
| **Persona PDPs** | Product pages adapted per persona (8 variants) |
| **Comparisons** | Head-to-head product comparisons |
| **Guides** | Fundamentals, intermediate, advanced, filter, milk, sourcing techniques |
| **Experiences** | Core personas, morning rituals, seasonal, social contexts, life moments, home setups |
| **Blog** | Brand stories, how-tos, travel, community |
| **Tools** | Calculators, pairing guides, maintenance guides |
| **Bundles** | Budget-tier kits and persona kits |

Plus **284 draft HTML pages** ready for authoring.

---

## Slide 10: Streaming Experience (SSE)

Events stream to the browser in this order:

1. **`generation-start`** — Query acknowledged, estimated block count
2. **`reasoning-start`** → **`reasoning-step`** (multiple) → **`reasoning-complete`** — "Understanding → Assessment → Decision" so users see *why* these recommendations
3. **`block-start`** → **`block-content`** — Blocks appear one by one (hero, then product cards, then content, etc.)
4. **`block-rationale`** — Why each block was chosen (optional, per block)
5. **`image-ready`** — AI-generated or matched images replace placeholders
6. **`generation-complete`** — Summary (intent, blocks, duration, journey stage, follow-up suggestions)
7. **`complete`** — Final signal; page is ready

**No single "loading" screen** — the page builds in front of the user.

---

## Slide 11: Auto-Persist to AEM (Save to Site)

- After generation completes, the page **auto-persists** to Document Authoring (DA)
- Backend flow: **create page → preview → wait for readiness → publish → purge CDN**
- Response returns **preview** and **live** URLs on aem.live
- A `page-published` event fires on the frontend for analytics
- Page is then a normal AEM EDS page: editable, versioned, and cacheable

**From "AI-generated" to "published page" — automatically.**

---

## Slide 12: Browsing Context Flow

```
Regular Pages                              Recommender Query (/?q=...)
─────────────                              ────────────────────────────
 ┌──────────────────┐                     ┌──────────────────────────────────────┐
 │ Delayed Phase    │                     │ scripts.js / renderArcoRecommender   │
 │ (3s after load)  │                     │                                      │
 │                  │                     │ 1. Read session context              │
 │ browsing-        │                     │ 2. Encode ctx (queries + browsing)   │
 │  signals.js      │                     │ 3. SSE stream to backend             │
 │                  │                     └──────────┬───────────────────────────┘
 │ • Page signal    │                                │
 │ • Scroll depth   │                                ▼
 │ • Quiz answers   │                     ┌──────────────────────────────────────┐
 │ • Product filters│                     │ Backend Orchestrator                 │
 │ • Tab switches   │                     │                                      │
 │ • Video plays    │                     │ 1. classifyIntent() — uses browsing  │
 └────────┬─────────┘                     │    context + conversation history    │
          │                               │ 2. RAG context + vector search       │
          ▼                               │ 3. Deep reasoning (block selection)  │
 ┌──────────────────┐                     │ 4. Parallel content generation       │
 │ Session Context  │                     │ 5. Follow-up suggestions informed    │
 │ (sessionStorage) │◄────────────────────│    by products viewed & interests    │
 │                  │                     └──────────────────────────────────────┘
 │ • queries[]      │
 │ • browsingHist[] │          ┌──────────────────────────────────┐
 │ • inferredProfile│─────────►│ "For You" Background Prefetch    │
 └──────────────────┘          │ Synthesize query → pre-generate  │
                               │ → instant nav link               │
                               └──────────────────────────────────┘
```

---

## Slide 13: Model Presets (16 Available)

| Preset | Models | Approx. Time |
|--------|--------|-------------|
| `production` (default) | Gemini 3 Pro (reasoning) + 2.5 Flash Lite (content) | ~23s |
| `gemini-3-pro` | Pure Gemini 3 Pro | ~25s |
| `gemini-3-flash` | Pure Gemini 3 Flash | ~12s |
| `gemini-3-mixed` | 3 Pro reasoning + 3 Flash content | ~18s |
| `gemini-2.5-pro` | Pure Gemini 2.5 Pro | ~25s |
| `gemini-2.5-flash` | Pure Gemini 2.5 Flash | ~18s |
| `gemini-2.5-flash-lite` | Pure Gemini 2.5 Flash Lite | ~8s |
| `gemini-2.5-mixed` | 2.5 Pro reasoning + 2.5 Flash Lite content | ~21s |
| `gemini-2.0-flash` | Pure Gemini 2.0 Flash | ~4s |
| `gemini-2.0-flash-lite` | Pure Gemini 2.0 Flash Lite | ~7s |
| `gemini-2.0-mixed` | 2.0 Flash reasoning + 2.0 Flash Lite content | ~4s |
| `llama-3.3-70b-instruct-maas` | Llama 3.3 70B (Model Garden) | ~6s |
| `llama-3.2-3b` | Llama 3.2 3B (Model Garden) | ~6s |
| `mistral-small` | Mistral Small (Model Garden) | ~6s |
| `gemma-3-4b` | Gemma 3 4B (Model Garden) | ~— |
| `gemma-3-12b` | Gemma 3 12B (Model Garden) | ~— |

The recommender runs a **4-role pipeline** (classification → reasoning → content → validation), and each preset assigns different models to these roles.

---

## Slide 14: Demo Script (Suggested Order)

1. **Take the quiz** — Answer 4 questions. Notice the homepage adapts: hero, product cards, blog feed, and nav CTA change for your persona.
2. **Browse** — Visit a product page, scroll through a brew guide, switch some tabs. This builds browsing context. Watch for the "For You" link to appear in the nav.
3. **Click "For You"** — The page renders instantly from the background prefetch, personalized to your browsing behavior.
4. **Query 1:** Type a discovery query (e.g. `?q=best espresso machine for beginners`) — show reasoning steps streaming, then blocks appearing one by one.
5. **Query 2:** A follow-up (e.g. `?q=something similar but more compact`) — show how the AI adapts based on session context and browsing history.
6. **Check:** Open the auto-persisted page on aem.live preview/live URLs.
7. **Optional:** Switch presets (e.g. `&preset=gemini-2.0-flash` for speed vs `&preset=gemini-3-pro` for quality) and compare.

---

## Slide 15: Key Takeaways

- **Three personalization paths** — Persona quiz (instant), query generation (on-demand), "For You" prefetch (proactive).
- **Intent-driven composition** — 13 intent types × 3 journey stages → AI selects from 21 block types.
- **6 personas** — Quiz-driven personalization adapts hero, products, blog, nav, and CTAs.
- **Browsing-aware** — Passive signal collection drives both "For You" prefetch and richer query context.
- **Streaming** — Reasoning and blocks stream via SSE; no single "loading" cliff.
- **Auto-persist** — Generated pages are automatically saved to AEM and published like any EDS page.
- **257-file content corpus** — Products, guides, experiences, blog, tools, and bundles grounding AI responses.
- **16 model presets** — From ~4s (Gemini 2.0 Flash) to ~25s (Gemini 3 Pro); mix and match across 4 pipeline roles.
- **Stack** — AEM Edge Delivery Services + Google Cloud (Cloud Run, Vertex AI, Model Garden, Firestore, Cloud Functions, DA).

---

## Slide 16: Links & Resources

- **Live demo:** Your EDS site URL (e.g. `https://main--your-project--your-org.aem.page/`)
- **Try with preset:** e.g. `?q=your+query&preset=production`
- **Docs:** PRESETS.md (model benchmarks), BENCHMARK.md (performance data), AGENTS.md (project overview)

**Q&A**

---

*End of presentation.*
