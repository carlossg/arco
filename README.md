# Your Project's Title...
Your project's description...

## Environments
- Preview: https://main--{repo}--{owner}.aem.page/
- Live: https://main--{repo}--{owner}.aem.live/

## Documentation

Before using the aem-boilerplate, we recommand you to go through the documentation on https://www.aem.live/docs/ and more specifically:
1. [Developer Tutorial](https://www.aem.live/developer/tutorial)
2. [The Anatomy of a Project](https://www.aem.live/developer/anatomy-of-a-project)
3. [Web Performance](https://www.aem.live/developer/keeping-it-100)
4. [Markup, Sections, Blocks, and Auto Blocking](https://www.aem.live/developer/markup-sections-blocks)

## Demo

![](https://github.com/user-attachments/assets/arco-demo.mp4)

The [demo video](build-demo/arco-demo.mp4) walks through Arco's AI-powered personalization features, running on Adobe Experience Manager Edge Delivery Services and Google Cloud.

1. **Passive signal collection** — As the user browses pages like *Espresso Anywhere* and the *Travel Espresso Guide*, the site passively collects browsing signals (page visits, scroll depth, time spent) and builds a real-time interest profile stored in the browser session.

2. **Personalized "For You" recommendations** — A *For You* link appears in the navigation based on the user's browsing behavior. Clicking it sends the browsing context to the backend, which uses Gemini models on Vertex AI to generate a set of recommendations tailored to the user's interests. The page streams in via server-sent events.

3. **Natural language AI search** — The user types a query like *"I'm looking for a coffee machine to use when camping in the middle of the forest"*. The backend runs a hybrid RAG pipeline combining keyword search with semantic vector search powered by Vertex AI text embeddings. A combination of Gemini models and locally hosted models on Vertex AI reason over the results and generate a fully personalized page in real time.

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
| `preset` | `/?q=...&preset=gemini-3-pro` | Model preset (default: `production`) |
| `regen` | `/?q=...&regen` | Force regeneration, skip cache |

## Local development

1. Create a new repository based on the `aem-boilerplate` template
1. Add the [AEM Code Sync GitHub App](https://github.com/apps/aem-code-sync) to the repository
1. Install the [AEM CLI](https://github.com/adobe/helix-cli): `npm install -g @adobe/aem-cli`
1. Start AEM Proxy: `aem up` (opens your browser at `http://localhost:3000`)
1. Open the `{repo}` directory in your favorite IDE and start coding :)
