# Napkin AI Prompt — Arco Architecture Diagram

Use the following text as input to [napkin.ai](https://napkin.ai) to generate a visual architecture diagram.

---

## Prompt

Arco is an AI-powered e-commerce website built on Adobe Experience Manager Edge Delivery Services. It has three main layers:

**Browser (Client)**
The browser loads pages from AEM's CDN. On regular pages, a browsing signal collector passively captures page visits, scroll depth, quiz answers, and interactions, storing them in sessionStorage as a session context (query history, browsing history, inferred profile). A persona cookie drives content personalisation across blocks like the hero banner and product cards.

When a user submits a natural language query (/?q=...), the browser reads the full session context and opens a Server-Sent Events stream to the Cloud Run recommender service.

**Cloud Run — arco-recommender (Backend)**
The recommender orchestrator runs a sequential pipeline:
1. Intent classification — Gemini 2.5 Pro reads the query + browsing context to classify intent and identify target products
2. Hybrid RAG — keyword search against DA content runs in parallel with semantic vector search against Firestore embeddings (Vertex AI text-embedding-005, 768 dimensions, cosine distance) across three collections: product embeddings, brew guide embeddings, FAQ embeddings
3. Reasoning engine — Gemini selects blocks and plans the page layout from the merged RAG context
4. Page generation — Gemini streams the final HTML page back to the browser as SSE chunks
5. Fire-and-forget analytics — three models (Gemini 2.5 Pro, Gemini 2.5 Flash, Llama 3.3 70B) evaluate the generated page in parallel across four dimensions: content quality, layout effectiveness, conversion potential, factual accuracy. Results are stored in Firestore and an analytics-available SSE event is sent to the browser.

**Google Cloud Platform**
- Firestore stores vector embeddings (product, brew guide, FAQ) and analytics results
- Vertex AI hosts Gemini 2.5 Pro and Flash for inference and text-embedding-005 for semantic search
- Secret Manager stores the DA authentication token

**Adobe Experience Manager (AEM)**
- Document Authoring (da.live) is the CMS where authors create and publish pages
- AEM Edge Delivery (Franklin CDN) serves all pages at aem.page and aem.live
- Code is synced from GitHub; content is published from DA

**Data flows:**
- Authors publish pages in DA → synced to AEM CDN → served to browser
- User browses → signals stored in sessionStorage → persona inferred → cookie set
- User queries → session context sent to Cloud Run → Gemini pipeline → SSE HTML stream → browser renders page
- Generated page quality evaluated by 3 AI models asynchronously → score displayed in browser

Show this as a clean layered architecture diagram with four swim lanes: Browser, Cloud Run, Google Cloud, and AEM/CDN. Use arrows to show the key data flows described above.
