// Scrapes today's dining hall menus from dining.columbia.edu using a real (headless
// or headed) browser, then upserts the result into the Supabase `daily_menus` table
// so api/menus.js can serve it without ever touching the site itself.
//
// WHY A BROWSER: dining.columbia.edu sits behind a Cloudflare bot-challenge that
// blocks plain HTTP requests (confirmed: `curl` with a normal browser User-Agent
// still gets a "Just a moment..." 403 page). A real browser that executes JS may get
// past a passive challenge — but Cloudflare can also fingerprint headless Chrome and
// block it anyway. We don't know which case we're in yet. That's what step 1 below
// is for.
//
// THIS FILE SHIPS AS A SCAFFOLD, NOT A FINISHED SCRAPER. `extractMenus()` below is a
// stub — nobody (not even Claude) can see dining.columbia.edu's real DOM through the
// Cloudflare challenge from this environment, so the CSS selectors have to come from
// a real run. Follow the two-step process:
//
//   STEP 1 — Discover
//     npm install
//     npx playwright install chromium
//     npm run scrape:menus:headed
//     This opens a real, visible browser window and navigates to TARGET_URL (see
//     below). Watch it: does the Cloudflare challenge clear on its own, or does it
//     hang / show a CAPTCHA? Either way, it saves the resulting HTML + a screenshot
//     to scripts/scrape-output/ so we can inspect the real markup afterward.
//     Click around manually in that window to find where the actual daily menu
//     (per dining hall, per meal period) lives, and note the URL — set TARGET_URL to
//     it if it differs from the default.
//
//   STEP 2 — Wire up extraction
//     Once we can see real markup (share scripts/scrape-output/page.html, or the
//     selectors you found), fill in extractMenus() to return data shaped like
//     SAMPLE_MENUS in api/menus.js. Then this script's upsertToSupabase() call will
//     start populating the daily_menus table for real, and api/menus.js will read
//     it automatically (see the SUPABASE READ section in api/menus.js).
//
// Run on a schedule (e.g. a GitHub Actions cron a couple times a day) with:
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY  (service role — this writes, unlike
//   the app's anon key) set as secrets. Locally without those set, this just prints
//   the scraped JSON instead of writing anywhere, so you can sanity-check output.

const fs = require('fs');
const path = require('path');

const TARGET_URL = process.env.MENU_URL || 'https://dining.columbia.edu/content/dining-hours-menus';
const HEADLESS = process.env.HEADLESS !== 'false';
const OUT_DIR = path.join(__dirname, 'scrape-output');

async function main() {
  const { chromium } = require('playwright');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: HEADLESS,
    // A real Chrome channel + realistic UA/viewport gives the best odds of clearing
    // a passive Cloudflare JS challenge. Still no guarantee against active bot
    // fingerprinting — see the note at the top of this file if this keeps failing.
    channel: 'chrome'
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US'
  });
  const page = await context.newPage();

  console.log(`Navigating to ${TARGET_URL} (headless=${HEADLESS})...`);
  await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 30000 }).catch(e => {
    console.warn('Navigation warning (continuing anyway):', e.message);
  });

  // Cloudflare's passive challenge typically clears itself within a few seconds if
  // it's going to clear at all.
  await page.waitForTimeout(6000);

  const html = await page.content();
  const stillChallenged = /Just a moment|Checking your browser|cf-browser-verification/i.test(html);

  await page.screenshot({ path: path.join(OUT_DIR, 'page.png'), fullPage: true });
  fs.writeFileSync(path.join(OUT_DIR, 'page.html'), html);

  console.log(stillChallenged
    ? '\n❌ Still looks like a Cloudflare challenge page. Open scripts/scrape-output/page.png to confirm. Headless browsing alone may not be enough here — see the note at the top of this file about headless fingerprinting / needing a scraping proxy service.'
    : '\n✅ Page does not look like a challenge page — saved scripts/scrape-output/page.html and page.png for inspection. Open the HTML and find the real selectors for dining hall / meal period / menu items, then fill in extractMenus() below.');

  const menus = extractMenus(html);
  if (menus) {
    console.log('\nExtracted menus:', JSON.stringify(menus, null, 2));
    await upsertToSupabase(menus);
  } else {
    console.log('\nextractMenus() returned nothing — expected until it\'s filled in with real selectors (see STEP 2 above).');
  }

  await browser.close();
}

// TODO (STEP 2): replace this stub once we've seen the real markup. Should return
// data shaped exactly like SAMPLE_MENUS in api/menus.js:
//   { Breakfast: { "Ferris": { hours, stations: [{ name, items: [...] }] } or { closed:true }, ... }, Lunch: {...}, ... }
function extractMenus(_html) {
  return null;
}

async function upsertToSupabase(menus) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.log('\n(SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping write, printed JSON above instead.)');
    return;
  }
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(url, key);
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, Columbia-local date
  const { error } = await supabase.from('daily_menus').upsert({
    date: today,
    menus,
    scraped_at: new Date().toISOString()
  });
  if (error) {
    console.error('Supabase write failed:', error.message);
    process.exitCode = 1;
  } else {
    console.log(`Wrote menus for ${today} to Supabase daily_menus.`);
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
