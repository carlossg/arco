# Arco: AI-Powered Generative Website on AEM Edge Delivery Services

Arco is a specialty espresso brand website that demonstrates how Adobe Experience Manager Edge Delivery Services and Cloudflare Workers can work together to deliver AI-powered personalization. The site passively learns from user browsing behavior and generates fully personalized pages in real time using a Cloudflare Worker with Vectorize RAG and Cerebras LLM.

## Demo

https://github.com/user-attachments/assets/64f534df-37ed-4c95-8422-9bba7f734d27

The [demo video](build-demo/arco-demo.mp4) walks through Arco's AI-powered personalization features, running on Adobe Experience Manager Edge Delivery Services.

1. **Passive signal collection** — As the user browses pages like *Espresso Anywhere* and the *Travel Espresso Guide*, the site passively collects browsing signals (page visits, scroll depth, time spent) and builds a real-time interest profile stored in the browser session.

2. **Personalized "For You" recommendations** — A *For You* link appears in the navigation based on the user's browsing behavior. Clicking it sends the browsing context to the backend, which generates a set of recommendations tailored to the user's interests. The page streams in progressively.

3. **Natural language AI search** — The user types a query like *"I'm looking for a coffee machine to use when camping in the middle of the forest"*. The backend runs a hybrid RAG pipeline combining keyword search with Cloudflare Vectorize semantic search. The LLM reasons over the results and generates a fully personalized page in real time.

4. **Instant caching** — Refreshing the page loads it instantly from the Edge Delivery cache with no AI pipeline needed. The same query always maps to the same deterministic URL.

### Rebuilding the demo

```sh
# Record the screen (requires local dev server running on localhost:3000)
cd build-demo && node record-demo.mjs

# Assemble the narrated video (requires ELEVENLABS_API_KEY in .env)
.venv/bin/python build.py
```

## Installation

```sh
npm i
```

## Linting

```sh
npm run lint
```

## Recommender

The site includes an AI-powered recommender at `/?q=...`. Generated pages are cached in DA so repeat queries redirect instantly instead of re-running the LLM pipeline.

| Parameter | Example | Description |
|-----------|---------|-------------|
| `q` | `/?q=best+espresso` | Natural language query |
| `preset` | `/?q=...&preset=default` | Model preset |
| `regen` | `/?q=...&regen` | Force regeneration, skip cache |

## Local development

1. Install dependencies: `npm i`
2. Install the [AEM CLI](https://github.com/adobe/helix-cli): `npm install -g @adobe/aem-cli`
3. Start the dev server: `aem up` (opens your browser at `http://localhost:3000`)
