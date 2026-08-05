# LionsFeast

Columbia dining menus, an off-campus food search backed by Claude, and meal-swipe /
spending tracking. Frontend is a single `index.html` (no build step); `api/` holds
Vercel serverless functions; Supabase handles auth + data.

## Local setup

```
npm install
```

Copy your real Supabase project values into `config.js` (already gitignored):
`SUPABASE_URL` and `SUPABASE_ANON_KEY` from Supabase → Project Settings → API.
Run `schema.sql` once in the Supabase SQL editor to create the tables.

## Running the app locally

The frontend calls `/api/search` and `/api/menus`, so a plain static server (e.g.
`npx serve .`) won't fully work — those routes will 404. Use the Vercel CLI instead,
which runs the `api/*.js` functions locally exactly as they'd run in production:

```
npm i -g vercel      # once
vercel dev
```

First run will ask to link a Vercel project (or you can skip linking and it still
serves locally). Set `ANTHROPIC_API_KEY` (for `/api/search`) either by linking to a
Vercel project that already has it set, or by creating a local `.env` file:

```
ANTHROPIC_API_KEY=sk-ant-...
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...   # only needed for the scraper, see below — never in config.js
```

Then open the URL `vercel dev` prints (usually `http://localhost:3000`).

## Testing the menu scraper

`dining.columbia.edu` sits behind a Cloudflare bot-challenge that blocks plain HTTP
requests, so menus can't be fetched with a simple `fetch()` — see the comment at the
top of `scripts/scrape-menus.js` for the full explanation. Getting a real scrape
working is a two-step process:

**Step 1 — see if a real browser gets past the challenge at all:**

```
npx playwright install chromium
npm run scrape:menus:headed
```

This opens a visible Chrome window and navigates to the dining menu page. Watch what
happens — does it load normally, or hang on "Just a moment..."? It saves the result
to `scripts/scrape-output/page.html` and `page.png` either way. Click around in that
window to find the actual URL where a day's per-hall, per-meal-period menu lives
(the default `TARGET_URL` is a best guess), and pass it via:

```
MENU_URL="https://dining.columbia.edu/whatever-the-real-page-is" npm run scrape:menus:headed
```

**Step 2 — wire up real extraction:** once you can see real markup in
`scripts/scrape-output/page.html`, share it (or the selectors you find in DevTools)
and `extractMenus()` in `scripts/scrape-menus.js` gets filled in to return real data.
From then on, running the script writes into the Supabase `daily_menus` table, and
`api/menus.js` reads from it automatically — no frontend changes needed.

**Production schedule:** `.github/workflows/scrape-menus.yml` runs the scraper twice
a day via GitHub Actions once this repo is pushed to GitHub, using `SUPABASE_URL` /
`SUPABASE_SERVICE_ROLE_KEY` repo secrets (Settings → Secrets and variables →
Actions). The service role key bypasses Row Level Security to write — never put it
in `config.js` or anything shipped to the browser.

## Deploying

Vercel build command should run `node scripts/generate-config.js` first (it writes
`config.js` from the `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SEMESTER_*` env vars set
in Vercel's Project Settings, since `config.js` itself is gitignored).
