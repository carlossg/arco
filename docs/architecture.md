# Arco Architecture Diagram

## System Overview

```mermaid
flowchart TD
    subgraph Browser["Browser (Client)"]
        direction TB
        SC[scripts.js\nPage Decoration]
        BS[browsing-signals.js\nSignal Collector]
        SM[session-context.js\nSessionStorage]
        Blocks[Blocks\nhero / product-card / product-detail\nanalytics-analysis / etc.]
        Quiz[Quiz Block\nPersona Detection]
        Cookie[arco_persona Cookie]
    end

    subgraph AEM["AEM Edge Delivery (aem.live)"]
        DA[Document Authoring\nda.live]
        CDN[CDN / Franklin Pipeline\naem.page / aem.live]
        Media[Media Assets\ncontent.da.live]
    end

    subgraph CloudRun["Cloud Run — arco-recommender"]
        direction TB
        ORC[Orchestrator\norchestrator.ts]
        RE[Reasoning Engine\nreasoning-engine.ts]
        RAG[Keyword RAG\ncontent-service.ts]
        VS[Vector Search\nvector-search.ts]
        AE[Analytics Engine\nanalytics-engine.ts]
        MF[Model Factory\nmodel-factory-google.ts]
    end

    subgraph GCP["Google Cloud Platform"]
        FS[(Firestore\nproduct_embeddings\nbrewguide_embeddings\nfaq_embeddings\nanalytics_results)]
        VAI[Vertex AI\ntext-embedding-005\nGemini 2.5 Pro/Flash]
        SM2[Secret Manager\nDA_TOKEN]
    end

    subgraph External["External AI"]
        Llama[Llama 3.3 70B\nvia Vertex AI]
    end

    %% Browser flow
    SC -->|Eager: decorate page| Blocks
    SC -->|Delayed phase| BS
    BS -->|store signals| SM
    BS -->|infer persona| Cookie
    Cookie -->|persona overrides| Blocks
    Quiz -->|set persona| Cookie

    %% Recommender query flow
    SC -->|"/?q=... SSE stream\n+ session context"| ORC

    %% Orchestrator pipeline
    ORC -->|classifyIntent| MF
    ORC -->|buildRAGContext| RAG
    ORC -->|semanticSearch| VS
    ORC -->|analyzeAndSelectBlocks| RE
    RE -->|generate page HTML| MF
    ORC -->|fire-and-forget| AE

    %% Data sources
    RAG -->|fetch content| DA
    VS -->|vector query| FS
    VS -->|embed query| VAI
    MF -->|inference| VAI
    AE -->|parallel eval| VAI
    AE -->|parallel eval| Llama
    AE -->|store results| FS

    %% AEM content delivery
    DA -->|sync| CDN
    CDN -->|serve HTML + assets| Browser
    Media -->|optimized images| Blocks

    %% Secrets
    SM2 -->|DA_TOKEN| CloudRun

    %% SSE response back to browser
    ORC -->|SSE events\npage chunks + analytics-available| SC
    SC -->|render generated page| Blocks
```

## Data Flow: Recommender Query

```mermaid
sequenceDiagram
    participant U as User
    participant B as Browser
    participant CR as Cloud Run
    participant FS as Firestore
    participant VAI as Vertex AI
    participant DA as DA (Content)

    U->>B: submits /?q=query
    B->>B: read sessionStorage<br/>(queries + browsing history + inferred profile)
    B->>CR: SSE POST /api/recommend<br/>{ query, sessionContext }

    CR->>VAI: classifyIntent(query + context)
    VAI-->>CR: intent + product targets

    par Hybrid RAG
        CR->>DA: keyword search (products, guides, FAQs)
        CR->>VAI: embed query → text-embedding-005
        VAI-->>CR: query vector
        CR->>FS: vector search (product/brewguide/faq embeddings)
        FS-->>CR: semantic matches
    end

    CR->>VAI: analyzeAndSelectBlocks(RAG context)
    VAI-->>CR: block selection + layout plan

    CR->>VAI: generate page HTML (streaming)
    VAI-->>B: SSE: page-chunk events
    B->>B: render generated page

    CR->>VAI: analytics eval (Gemini 2.5 Pro + Flash) [async]
    CR->>CR: analytics eval (Llama 3.3 70B) [async]
    CR->>FS: store analytics_results [async]
    CR-->>B: SSE: analytics-available { pageId, score }
    B->>B: render analytics-analysis block
```

## Key Components

| Layer | Component | Role |
|---|---|---|
| Client | `scripts/scripts.js` | Page decoration entry point; streams recommender queries |
| Client | `scripts/browsing-signals.js` | Passive signal collector + rule-based intent classifier |
| Client | `scripts/session-context.js` | SessionStorage manager — queries, browsing history, inferred profile |
| Client | `blocks/hero/` | Persona-aware hero with cookie-based content swap |
| Client | `blocks/product-detail/` | PDP block with gallery, specs, JSON-LD schema |
| Client | `blocks/analytics-analysis/` | Score ring + dimension bars from multi-agent eval |
| Client | `personalization/assembly-engine.js` | Runtime page composition from persona signal |
| Server | `orchestrator.ts` | Main pipeline — intent → RAG → reasoning → generation → analytics |
| Server | `reasoning-engine.ts` | Block selection and layout planning via Gemini |
| Server | `content-service.ts` | Keyword RAG + semantic search merge |
| Server | `vector-search.ts` | Firestore native vector search + Vertex AI embeddings |
| Server | `analytics-engine.ts` | Multi-model quality evaluation (3-model consensus) |
| Infra | Firestore | Vector collections + analytics results storage |
| Infra | Vertex AI | Gemini 2.5 Pro/Flash inference + text-embedding-005 |
| CMS | DA (da.live) | Content authoring and source of truth for all pages |
| CDN | AEM Edge Delivery | Content delivery via aem.page / aem.live |
