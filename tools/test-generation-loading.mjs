/* eslint-env node */
/* eslint import/no-extraneous-dependencies: ["error", { "devDependencies": true }] */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const origin = process.env.BASE_URL || 'http://localhost:3000';
let browser;

before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

async function createPage(width = 390) {
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  await page.route(
    (url) => /(^|\.)(workers\.dev|cloudflare\.com)$/.test(url.hostname),
    (route) => route.abort(),
  );
  await page.addInitScript(() => {
    sessionStorage.setItem('arco-welcome-shown', '1');
    window.loadingMetrics = { cls: 0, lcp: 0 };
    new PerformanceObserver((list) => {
      list.getEntries().forEach((entry) => {
        if (!entry.hadRecentInput) window.loadingMetrics.cls += entry.value;
      });
    }).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver((list) => {
      list.getEntries().forEach((entry) => {
        window.loadingMetrics.lcp = entry.startTime;
      });
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  });
  await page.route('**/api/track', (route) => route.fulfill({
    status: 204,
    headers: { 'Access-Control-Allow-Origin': '*' },
  }));
  return page;
}

[390, 1440].forEach((width) => {
  test(`real generation has stable layout at ${width}px`, async (t) => {
    const page = await createPage(width);
    const cloudflare = [];
    const errors = [];
    const imageRequests = [];
    let generating = false;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/generate') generating = true;
      if (generating && request.resourceType() === 'image') imageRequests.push(request.url());
      if (/(^|\.)(workers\.dev|cloudflare\.com)$/.test(new URL(request.url()).hostname)) {
        cloudflare.push(request.url());
      }
    });
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      const generated = page.waitForResponse((response) => (
        response.url().endsWith('/api/generate') && response.request().method() === 'POST'
      ));
      await page.goto(`${origin}/?q=portable+espresso+for+camping`);
      const response = await generated;
      assert.equal(response.status(), 200);
      await response.finished();
      const events = (await response.text()).trim().split('\n').map((line) => JSON.parse(line));
      assert.ok(events.some((event) => event.type === 'done'));
      assert.deepEqual(events.filter((event) => event.type === 'error'), []);
      await page.waitForFunction((count) => (
        document.querySelectorAll('#generation-content > .section[data-run-id][data-section-status="loaded"]').length === count
        && !document.querySelector('.generating-container')
      ), events.filter((event) => event.type === 'section').length);
      await page.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }));
      const metrics = await page.evaluate(() => window.loadingMetrics);
      t.diagnostic(JSON.stringify({ width, ...metrics }));
      const heroImage = page.locator('#generation-content .hero img').first();
      assert.equal(await heroImage.getAttribute('loading'), 'eager');
      assert.equal(await heroImage.getAttribute('fetchpriority'), 'high');
      assert.match(await heroImage.evaluate((image) => image.currentSrc), /format=webply/);
      const heroUrl = new URL(await heroImage.getAttribute('src'), origin);
      assert.deepEqual(imageRequests.filter((url) => {
        const candidate = new URL(url);
        return candidate.origin === heroUrl.origin && candidate.pathname === heroUrl.pathname
          && !candidate.searchParams.has('format');
      }), [], 'The unoptimized hero must never be downloaded');
      assert.ok(metrics.cls < 0.1, `CLS ${metrics.cls} must remain below 0.1`);
      assert.equal(await page.evaluate(() => (
        document.documentElement.scrollWidth > window.innerWidth
      )), false);
      assert.deepEqual(cloudflare, []);
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
});

[false, true].forEach((late) => {
  test(`stream errors remain visible ${late ? 'after' : 'before'} the first section`, async () => {
    const page = await createPage();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const message = 'Upstream unavailable <retry>';
    const events = [
      ...(late ? [{
        type: 'section',
        html: '<div class="hero"><div><div><h1>Partial recommendation</h1></div></div></div>',
      }] : []),
      { type: 'error', message },
    ];
    await page.route('**/api/generate', async (route) => {
      await gate;
      await route.fulfill({
        contentType: 'application/x-ndjson',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
      });
    });
    try {
      await page.goto(`${origin}/?q=${encodeURIComponent('<strong>literal query</strong>')}`);
      await page.locator('.generating-query').waitFor();
      assert.match(await page.locator('.generating-query').innerText(), /<strong>literal query/);
      assert.equal(await page.locator('.generating-query strong').count(), 0);
      release();
      await page.locator('[role="alert"]').waitFor();
      await page.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }));
      assert.equal(await page.locator('[role="alert"]').isVisible(), true);
      assert.ok((await page.locator('[role="alert"]').innerText()).includes(message));
      assert.equal(await page.locator('[role="alert"] retry').count(), 0);
      assert.equal(await page.locator('#generation-content h1').count(), late ? 1 : 0);
    } finally {
      release();
      await page.close();
    }
  });
});

[390, 768, 1440].forEach((width) => {
  test(`For You records quick browsing before delayed code without counting twice at ${width}px`, async () => {
    const page = await createPage(width);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/scripts/delayed.js', (route) => route.fulfill({
      contentType: 'application/javascript', body: '',
    }));
    try {
      await page.goto(`${origin}/`);
      await page.locator('.nav-foryou-link').waitFor({ state: 'attached' });
      assert.equal(await page.locator('.nav-foryou-link').getAttribute('aria-disabled'), 'true');
      assert.match(await page.locator('.nav-foryou').getAttribute('title'), /Browse two pages/);
      await page.goto(`${origin}/products/espresso-machines`);
      await page.waitForFunction(() => (
        document.querySelector('.nav-foryou-link')?.getAttribute('aria-disabled') === 'false'
      ));
      const visits = await page.evaluate(() => JSON.parse(
        sessionStorage.getItem('arco-session-context'),
      ).browsingHistory);
      assert.deepEqual(visits.map((visit) => visit.path), ['/', '/products/espresso-machines']);
      // eslint-disable-next-line import/no-unresolved, import/no-absolute-path
      await page.evaluate(async () => (await import('/scripts/browsing-signals.js')).collectBrowsingSignals());
      const context = await page.evaluate(() => JSON.parse(
        sessionStorage.getItem('arco-session-context'),
      ));
      assert.equal(context.browsingHistory.length, 2);
      assert.equal(context.inferredProfile.pagesVisited, 2);
      assert.ok(context.browsingHistory[1].blocks.length > 0);
      if (width < 900) await page.locator('.nav-hamburger button').click();
      assert.equal(await page.locator('.nav-foryou-link').isVisible(), true);
      assert.equal(await page.locator('.nav-foryou-link').evaluate((link) => (
        getComputedStyle(link).pointerEvents
      )), 'auto');
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
});

test('For You unlocks after a query completes without a browsing event or reload', async () => {
  const page = await createPage(1440);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  await page.route('**/api/generate', async (route) => {
    calls += 1;
    if (calls === 1) await gate;
    await route.fulfill({
      contentType: 'application/x-ndjson',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: '{"type":"done"}\n',
    });
  });
  try {
    await page.goto(`${origin}/?q=Compare+Primo+and+Doppio`);
    await page.locator('.nav-foryou-link').waitFor({ state: 'attached' });
    assert.equal(await page.locator('.nav-foryou-link').getAttribute('aria-disabled'), 'true');
    release();
    await page.waitForFunction(() => (
      document.querySelector('.nav-foryou-link')?.getAttribute('aria-disabled') === 'false'
    ));
    const nextRequest = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/generate');
    await page.locator('.nav-foryou-link').click();
    const body = (await nextRequest).postDataJSON();
    assert.equal(body.context.previousQueries[0].query, 'Compare Primo and Doppio');
    assert.equal(body.context.browsingHistory?.length || 0, 0);
  } finally {
    release();
    await page.close();
  }
});

[390, 768, 1440].flatMap((width) => [false, true].map((handoff) => ({
  width, handoff,
}))).forEach(({ width, handoff }) => {
  test(`external app context ${handoff ? 'handoff' : 'URL'} hydrates before generation and is inspectable at ${width}px`, async () => {
    const page = await createPage(width);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const incoming = {
      inferredProfile: { interests: ['milk drinks', '<img src=x onerror=alert(1)>'], journeyStage: 'comparing' },
      shownProducts: ['primo', 'doppio'],
      conversationContext: {
        summary: 'Comparing machines for a shared compact kitchen.',
        preferences: {
          budgetUsd: 1600,
          drinks: ['cappuccino'],
          people: 2,
          priorities: ['quiet operation', '<img src=x onerror=alert(1)>'],
        },
        productsDiscussed: ['primo', 'doppio'],
      },
    };
    let requestBody;
    let retrieved = false;
    await page.route('**/api/mcp/context/*', (route) => {
      assert.equal(requestBody, undefined, 'Context must be loaded before generation');
      retrieved = true;
      return route.fulfill({
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
        body: JSON.stringify({
          context: incoming, expiresAt: new Date(Date.now() + 3600000).toISOString(),
        }),
      });
    });
    await page.route('**/api/generate', async (route) => {
      assert.equal(retrieved, handoff);
      requestBody = route.request().postDataJSON();
      await route.fulfill({
        contentType: 'application/x-ndjson',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: '{"type":"done","title":"Context test"}\n',
      });
    });
    const params = new URLSearchParams({
      q: 'Compare Primo and Doppio',
      persona: 'upgrade-seeker',
      ctx: Buffer.from(JSON.stringify(incoming)).toString('base64url'),
      utm_source: 'gemini',
      utm_medium: 'connected_app',
      utm_campaign: 'mcp_concierge',
    });
    if (handoff) {
      params.delete('ctx');
      params.set('contextId', '5da98b6f-6fc9-413b-9d0c-25ee06818e41');
    }
    try {
      await page.goto(`${origin}/?${params}`);
      const summary = page.locator('.external-context summary');
      await summary.click();
      await page.waitForFunction(() => (
        document.querySelector('.external-context pre')?.textContent.includes('"generationContext": {')
      ));
      assert.deepEqual(requestBody.context.quizPersona, { persona: 'upgrade-seeker' });
      assert.deepEqual(requestBody.context.inferredProfile, incoming.inferredProfile);
      assert.deepEqual(requestBody.context.shownContent.shownProducts, incoming.shownProducts);
      assert.deepEqual(requestBody.context.conversationContext, incoming.conversationContext);
      const inspected = JSON.parse(await page.locator('.external-context pre').textContent());
      assert.deepEqual(inspected.received, incoming);
      assert.deepEqual(inspected.generationContext, requestBody.context);
      assert.equal(inspected.attribution.utm_campaign, 'mcp_concierge');
      assert.equal(await page.locator('.external-context img').count(), 0);
      const hasOverflow = await page.evaluate(() => (
        document.documentElement.scrollWidth > window.innerWidth
      ));
      assert.equal(hasOverflow, false);
      // eslint-disable-next-line import/no-unresolved, import/no-absolute-path
      const utm = await page.evaluate(async () => (await import('/scripts/analytics-events.js')).getUtm());
      assert.deepEqual(utm, { utmSource: 'gemini', utmMedium: 'connected_app', utmCampaign: 'mcp_concierge' });
      await page.waitForFunction(() => (
        document.querySelector('.nav-foryou-link')?.getAttribute('aria-disabled') === 'false'
      ));
      if (width < 900) await page.locator('.nav-hamburger button').click();
      const nextRequest = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/generate');
      await page.locator('.nav-foryou-link').click();
      const forYouBody = (await nextRequest).postDataJSON();
      assert.deepEqual(forYouBody.context.conversationContext, incoming.conversationContext);
      assert.deepEqual(forYouBody.context.quizPersona, { persona: 'upgrade-seeker' });
      assert.equal(forYouBody.context.browsingHistory?.length || 0, 0);
      assert.doesNotMatch(forYouBody.query, /1600|shared compact kitchen|quiet operation/);
      assert.deepEqual(errors, []);
      if (process.env.CONTEXT_SCREENSHOT_DIR) {
        await page.locator('.external-context').screenshot({
          path: `${process.env.CONTEXT_SCREENSHOT_DIR}/external-context-${handoff ? 'handoff' : 'url'}-${width}.png`,
        });
      }
    } finally {
      await page.close();
    }
  });
});

test('live MCP conversation context reaches Firestore retrieval and real Arco generation', {
  skip: process.env.MCP_CONTEXT_E2E !== '1',
}, async (t) => {
  const page = await createPage();
  const errors = [];
  const cloudflare = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (/(^|\.)(workers\.dev|cloudflare\.com)$/.test(new URL(request.url()).hostname)) {
      cloudflare.push(request.url());
    }
  });
  const mcp = process.env.MCP_URL
    || 'https://arco-recommender.cloud.run/mcp';
  const context = {
    summary: 'Two people make cappuccinos each morning in a small shared kitchen.',
    preferences: {
      budgetUsd: 1600,
      drinks: ['cappuccino'],
      people: 2,
      priorities: ['quiet operation', 'small footprint'],
    },
    productsDiscussed: ['primo', 'doppio'],
  };
  await page.addInitScript((baseUrl) => {
    window.ARCO_CONFIG = { RECOMMENDER_URL: baseUrl };
  }, new URL(mcp).origin);
  try {
    const called = await page.request.post(mcp, {
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'compare_products',
          arguments: { productA: 'Primo', productB: 'Doppio', conversationContext: context },
        },
      },
    });
    assert.equal(called.status(), 200);
    const { result } = await called.json();
    assert.equal(result.isError, false);
    const link = new URL(result.structuredContent.storefrontUrl);
    assert.ok(link.searchParams.get('contextId'));
    assert.equal(link.searchParams.has('ctx'), false);
    const generated = page.waitForResponse((response) => (
      response.url().endsWith('/api/generate') && response.request().method() === 'POST'
    ));
    await page.goto(`${origin}${link.pathname}${link.search}`);
    const response = await generated;
    assert.equal(response.status(), 200);
    await response.finished();
    const body = response.request().postDataJSON();
    assert.deepEqual(body.context.conversationContext, context);
    const events = (await response.text()).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(events.filter((event) => event.type === 'error'), []);
    assert.ok(events.some((event) => event.type === 'done'));
    const debug = events.find((event) => event.type === 'debug');
    assert.equal(debug.llm.provider, 'gemini');
    assert.ok(debug.prompt.userMessage.includes(JSON.stringify(context)));
    const sections = events.filter((event) => event.type === 'section');
    assert.ok(sections.length);
    const html = sections.map((event) => event.html).join('\n');
    assert.match(html, /cappuccino|milk/i);
    assert.match(html, /quiet|rotary|noise|silent|sound/i);
    await page.locator('.external-context summary').click();
    const inspected = JSON.parse(await page.locator('.external-context pre').textContent());
    assert.deepEqual(inspected.received.conversationContext, context);
    assert.deepEqual(inspected.generationContext, body.context);
    assert.deepEqual(cloudflare, []);
    assert.deepEqual(errors, []);
    t.diagnostic(JSON.stringify({
      runId: body.runId,
      contextId: link.searchParams.get('contextId'),
      model: debug.llm.model,
      sections: sections.length,
      contextInPrompt: true,
    }));
    if (process.env.CONTEXT_SCREENSHOT_DIR) {
      await page.screenshot({
        path: `${process.env.CONTEXT_SCREENSHOT_DIR}/live-mcp-context-generation.png`,
        fullPage: true,
      });
    }
  } finally {
    await page.close();
  }
});

test('external app context expiry is visible and generation never receives the expired summary', async () => {
  const page = await createPage();
  let requestBody;
  await page.route('**/api/mcp/context/*', (route) => route.fulfill({
    status: 410,
    contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: '{"error":"Expired"}',
  }));
  await page.route('**/api/generate', (route) => {
    requestBody = route.request().postDataJSON();
    return route.fulfill({
      contentType: 'application/x-ndjson',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: '{"type":"done","title":"No external preferences"}\n',
    });
  });
  try {
    await page.goto(`${origin}/?q=Compare+Primo+and+Doppio&contextId=5da98b6f-6fc9-413b-9d0c-25ee06818e41&utm_source=gemini`);
    await page.locator('.external-context summary').click();
    await page.waitForFunction(() => (
      document.querySelector('.external-context pre')?.textContent.includes('"generationContext": {')
    ));
    assert.match(await page.locator('.external-context summary').textContent(), /validation warning/);
    const inspected = JSON.parse(await page.locator('.external-context pre').textContent());
    assert.match(inspected.errors[0], /expired or was not found/);
    assert.equal(requestBody.context.conversationContext, undefined);
  } finally {
    await page.close();
  }
});
