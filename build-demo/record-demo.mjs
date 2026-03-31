import { chromium } from 'playwright';
import { setTimeout as sleep } from 'timers/promises';

const BASE_URL = 'http://localhost:3000';
const RECORDING_DIR = './recordings';

async function typeSlowly(page, selector, text, delayMs = 80) {
  const el = await page.waitForSelector(selector, { timeout: 15000 });
  await el.click();
  await sleep(500);
  for (const char of text) {
    await page.keyboard.type(char, { delay: delayMs });
  }
}

async function smoothScroll(page, steps = 8, pauseMs = 600) {
  for (let i = 0; i < steps; i++) {
    await page.evaluate(({ step, total }) => {
      const totalHeight = document.body.scrollHeight - window.innerHeight;
      const target = (totalHeight / (total - 1)) * step;
      window.scrollTo({ top: target, behavior: 'smooth' });
    }, { step: i, total: steps });
    await sleep(pauseMs);
  }
}

async function waitForFullLoad(page, extraMs = 2000) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await sleep(extraMs);
}

async function clickNavDrop(page, keyword) {
  await page.evaluate((kw) => {
    const navDrops = document.querySelectorAll('.nav-drop');
    for (const drop of navDrops) {
      const link = drop.querySelector('a');
      if (link && (link.textContent.includes(kw) || link.href.toLowerCase().includes(kw.toLowerCase()))) {
        drop.click();
        break;
      }
    }
  }, keyword);
  await sleep(800);
}

async function clickLink(page, hrefPattern) {
  await page.evaluate((pattern) => {
    const link = document.querySelector(`a[href*="${pattern}"]`);
    if (link) link.click();
  }, hrefPattern);
}

(async () => {
  console.log('Launching browser with video recording...');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    recordVideo: {
      dir: RECORDING_DIR,
      size: { width: 1920, height: 1080 },
    },
  });

  const page = await context.newPage();

  try {
    // ═══════════════════════════════════════════════════════════
    // ACT 1: Homepage
    // ═══════════════════════════════════════════════════════════
    console.log('ACT 1: Homepage...');
    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
    await waitForFullLoad(page, 2000);
    await smoothScroll(page, 5, 500);
    await sleep(1000);

    // ═══════════════════════════════════════════════════════════
    // ACT 2: Espresso Anywhere (signal collection)
    // ═══════════════════════════════════════════════════════════
    console.log('ACT 2: Espresso Anywhere...');
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await sleep(500);
    await clickNavDrop(page, 'Experience');
    await clickLink(page, 'espresso-anywhere');
    await waitForFullLoad(page, 2000);
    await smoothScroll(page, 8, 600);
    await sleep(2000);

    // ═══════════════════════════════════════════════════════════
    // ACT 3: Travel Espresso Guide (signal collection)
    // ═══════════════════════════════════════════════════════════
    console.log('ACT 3: Travel Espresso Guide...');
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await sleep(500);
    await clickNavDrop(page, 'Stories');
    await clickLink(page, 'travel-espresso-guide');
    await waitForFullLoad(page, 2000);
    await smoothScroll(page, 8, 600);
    await sleep(2000);

    // ═══════════════════════════════════════════════════════════
    // ACT 4: For You (pre-computed personalized recommendations)
    // ═══════════════════════════════════════════════════════════
    console.log('ACT 4: For You...');
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await sleep(1000);

    // Wait for "For You" link to appear in nav
    let forYouFound = false;
    for (let i = 0; i < 15; i++) {
      const forYou = await page.$('a[href*="for-you"], a:text("For You"), nav a:text-is("For You")');
      if (forYou && await forYou.isVisible()) {
        console.log('Found "For You" link, clicking...');
        await forYou.click();
        forYouFound = true;
        break;
      }
      await sleep(1000);
    }

    if (!forYouFound) {
      const links = await page.$$('a');
      for (const link of links) {
        const text = await link.textContent();
        if (text && text.trim().toLowerCase().includes('for you')) {
          console.log('Found "For You" via text search, clicking...');
          await link.click();
          forYouFound = true;
          break;
        }
      }
    }

    if (forYouFound) {
      console.log('Waiting for For You generation...');
      // Wait for SSE generation (up to 90s)
      const fyStart = Date.now();
      while (Date.now() - fyStart < 90000) {
        const info = await page.evaluate(() => ({
          text: document.body?.innerText?.length || 0,
          blocks: document.querySelectorAll('.section, .block').length,
        }));
        console.log(`  Content: ${info.text}, Blocks: ${info.blocks}`);
        if (info.text > 800 && info.blocks > 3) break;
        await sleep(3000);
      }
      await sleep(2000);
      await smoothScroll(page, 10, 700);
      await sleep(1000);
    } else {
      console.log('WARNING: "For You" not found, skipping...');
    }

    // ═══════════════════════════════════════════════════════════
    // ACT 5: AI Search — back to homepage, type query
    // ═══════════════════════════════════════════════════════════
    console.log('ACT 5: AI Search...');
    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
    await waitForFullLoad(page, 2000);

    console.log('Typing search query...');
    const searchSelectors = [
      'input[type="search"]',
      'input[name="q"]',
      'input[placeholder*="search" i]',
      'input[placeholder*="ask" i]',
      'input[placeholder*="looking" i]',
    ];

    let searchFound = false;
    for (const sel of searchSelectors) {
      try {
        const el = await page.$(sel);
        if (el && await el.isVisible()) {
          await typeSlowly(page, sel, "I'm looking for a coffee machine to use when camping in the middle of the forest", 55);
          searchFound = true;
          break;
        }
      } catch { /* try next */ }
    }

    if (!searchFound) {
      const inputs = await page.$$('input');
      for (const input of inputs) {
        if (await input.isVisible()) {
          await input.click();
          await sleep(300);
          await page.keyboard.type("I'm looking for a coffee machine to use when camping in the middle of the forest", { delay: 55 });
          searchFound = true;
          break;
        }
      }
    }

    await sleep(800);
    await page.keyboard.press('Enter');
    console.log('Submitted search, waiting for SSE results...');

    await sleep(5000);
    const startTime = Date.now();
    while (Date.now() - startTime < 90000) {
      const info = await page.evaluate(() => ({
        text: document.body?.innerText?.length || 0,
        blocks: document.querySelectorAll('.section, .block').length,
      }));
      console.log(`  Content: ${info.text}, Blocks: ${info.blocks}`);
      if (info.text > 800 && info.blocks > 3) {
        console.log('Generation complete!');
        break;
      }
      await sleep(3000);
    }

    await sleep(2000);
    await smoothScroll(page, 10, 700);
    await sleep(1000);

    // ═══════════════════════════════════════════════════════════
    // ACT 6: Cache Performance — refresh
    // ═══════════════════════════════════════════════════════════
    console.log('ACT 6: Cache reload...');
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await sleep(500);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForFullLoad(page, 2000);
    await smoothScroll(page, 8, 600);
    await sleep(1000);

    // Scroll back to top for clean ending
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await sleep(1500);

    console.log('Recording complete!');

  } catch (err) {
    console.error('Error during recording:', err);
  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }

  console.log(`Video saved to ${RECORDING_DIR}/`);
})();
