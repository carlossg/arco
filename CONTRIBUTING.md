# Contributing to Arco

This project is an AEM Edge Delivery Services site. It uses vanilla JS/CSS with no build steps.

## Code Of Conduct

This project adheres to the Adobe [code of conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## Before You Contribute

- Check that there is an existing issue in GitHub issues
- Check if there are other pull requests that might overlap or conflict with your intended contribution

---

## Development Setup

### Prerequisites

- Node.js (LTS)
- AEM CLI: `npm install -g @adobe/aem-cli`

### Install and Run

```bash
npm install
aem up   # starts dev server at http://localhost:3000
```

The dev server serves code from your working copy (including uncommitted changes) and content from the AEM preview backend. Changes auto-reload.

### Cloudflare Worker (Recommender)

```bash
cd workers/recommender
npm install
npx wrangler dev   # local worker at http://localhost:8787
```

Secrets are managed via `wrangler secret put` (not committed). Required:
- `CEREBRAS_API_KEY`
- `DA_CLIENT_ID`, `DA_CLIENT_SECRET`, `DA_SERVICE_TOKEN`

---

<!-- AUTO-GENERATED -->
## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run lint` | Run ESLint + Stylelint |
| `npm run lint:js` | Run ESLint only |
| `npm run lint:css` | Run Stylelint on block and global CSS |
| `npm run lint:fix` | Auto-fix lint issues |
| `npm run loadtest` | Run load test against the recommender |
| `npm run loadtest:quick` | Quick load test (10 requests, 2 parallel) |
| `npm run loadtest:generate-prompts` | Generate load test prompts |
<!-- /AUTO-GENERATED -->

---

## How to Contribute

1. Create a feature branch (prefer `git worktree` to keep `main` clean)
2. Make changes and verify locally at `http://localhost:3000`
3. Run `npm run lint` before committing — CI will reject lint failures
4. Open a pull request to `main`

In your PR, include:
- What the change does and why
- A link to `https://{branch}--arco--froesef.aem.page/{path}` showing the feature in action — **PRs without a preview URL will be rejected**
- If no live page exists, create a static draft in `drafts/` and ask for help publishing it

---

## Coding Styleguides

### JavaScript
- ES6+, no transpiling, no bundler
- Airbnb ESLint rules (configured)
- Always include `.js` extensions in imports
- Block JS files export a default `decorate(block)` function

### CSS
- Stylelint standard configuration
- Mobile-first; breakpoints at `600px`, `900px`, `1200px`
- Scope all selectors to the block: `.blockname .item` not `.item`
- Avoid `.blockname-container` and `.blockname-wrapper` (reserved by AEM)

### Commit Messages
- Reference a GitHub issue where applicable: `Fix product card layout (#42)`
- Use `[trivial]` for minor changes that don't relate to an issue

---

## Testing

There is no automated test suite for the front-end. Test manually:

1. Start the dev server (`aem up`)
2. Open `http://localhost:3000` in a browser
3. Test the golden path and edge cases for your feature
4. Check the browser console for errors
5. Run `npm run lint` — no errors before opening a PR

For the recommender worker, integration testing is done via load tests (`npm run loadtest`).

---

## How Contributions Get Reviewed

A maintainer will review pull requests within one week. Feedback is provided in writing on GitHub.

---

## Deployment

See the [AGENTS.md](AGENTS.md) Publishing Process section for full deployment instructions. Summary:

1. Push to a feature branch → available at `https://{branch}--arco--froesef.aem.page/`
2. Run a PageSpeed Insights check against the feature preview URL (target 100)
3. Open a PR to `main` with a preview URL
4. After merge, AEM Code Sync publishes to production automatically
