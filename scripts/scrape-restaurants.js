// Refreshes the curated off-campus restaurant pool that api/chat.js reads from
// so Roarie can usually answer without live-searching. Run on a schedule outside
// Vercel (cron, GitHub Actions, etc.) — same "outside the platform" pattern as
// scripts/scrape-menus.js, just verifying restaurant menus instead of scraping
// dining.columbia.edu.
//
// For each candidate name below, this asks Claude (with the same web_search tool
// api/chat.js uses) to verify the restaurant's real current address and menu
// prices — never guessed, exactly the standard Roarie's own system prompt
// enforces for live chat — and upserts the result into the Supabase
// `curated_restaurants` table. api/chat.js then injects that table's contents
// into Roarie's system prompt so it can skip searching for anything already in
// the pool, only falling back to live search for restaurants outside it.
//
// Candidates are name-only on purpose: addresses found via a quick web search can
// disagree between sources (confirmed while researching this list — Yelp and
// Tripadvisor gave two different street numbers for the same pizza place), so the
// address/menu itself is left to Claude's own verified web_search pass here
// rather than hand-typed from a snippet that might be stale or wrong.
const CANDIDATES = [
  'Koronet Pizza',
  "Tom's Restaurant",
  'Absolute Bagels',
  'Community Food & Juice',
  'Symposium Greek Restaurant',
  'Junzi Kitchen',
  'Miracle Thai',
  'Le Monde',
  'Tartina',
  'Doaba Deli',
  'JinRamen',
  'Nussbaum & Wu',
  'Massawa Ethiopian Restaurant',
  'V&T Pizzeria',
  "Amir's Grill",
  'Kitchenette',
  'Max Soha',
  "Mel's Burger Bar",
  'Sweetgreen Columbia',
  'Toast',
  'The Heights Bar & Grill',
  'Pisticci',
  'Flat Top',
  'Chipotle Mexican Grill 116th Street',
  'Spice Symphony',
  "Ollie's Sichuan",
  'Sal & Carmine Pizza',
  "Nikko's Sushi",
  'Chaiwali',
  "Milano Market"
];

const MODEL = 'claude-sonnet-5';

function slugify(name) {
  return name.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function verifyRestaurant(name) {
  const prompt = `Verify the real, current details for the restaurant "${name}" near Columbia University (116th St & Broadway, Morningside Heights, NYC). Use the web_search tool to check its official site, Google Maps listing, Yelp, or a delivery app page. Use only prices you actually find there — never guess, estimate, or recall a price from memory. If you can't verify a price for an item, leave that item out. If you can't find this restaurant at all near Columbia, say so.

Respond with ONLY raw JSON, no markdown fences and no commentary outside the JSON, in this exact shape:
{"found": true, "name": "...", "address": "...", "cuisine": "one or two words", "walk_minutes": N, "note": "one short sentence a campus food chatbot could say about it", "menu_items": [{"item":"...", "price":"$X"}]}
Set "found" to false (and leave the other fields empty/zero) if you cannot verify this is a real restaurant near Columbia.`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 4 }],
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const data = await resp.json();
  if (data.type === 'error') throw new Error(data.error?.message || 'Claude API error');

  const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  let clean = text.replace(/```json|```/g, '').trim();
  const s = clean.indexOf('{');
  const e = clean.lastIndexOf('}');
  if (s !== -1 && e !== -1) clean = clean.slice(s, e + 1);
  return JSON.parse(clean);
}

async function upsertToSupabase(rows) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.log('\n(SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping write, printed results above instead.)');
    return;
  }
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(url, key);
  const { error } = await supabase.from('curated_restaurants').upsert(rows);
  if (error) {
    console.error('Supabase write failed:', error.message);
    process.exitCode = 1;
  } else {
    console.log(`Wrote ${rows.length} restaurant(s) to Supabase curated_restaurants.`);
  }
}

// Verifies several restaurants at once instead of one-at-a-time — each is an
// independent Anthropic call, so there's no reason to serialize them. Keeps
// a modest concurrency cap rather than firing all of CANDIDATES at once, to
// stay well clear of per-minute rate limits.
const CONCURRENCY = 8;
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set — cannot verify restaurants.');
    process.exitCode = 1;
    return;
  }

  const rows = [];
  await mapWithConcurrency(CANDIDATES, CONCURRENCY, async (name) => {
    console.log(`Verifying "${name}"...`);
    try {
      const info = await verifyRestaurant(name);
      if (!info.found) {
        console.log(`  -> "${name}" not found/verifiable, skipping.`);
        return;
      }
      const row = {
        id: slugify(name),
        name: info.name || name,
        address: info.address || null,
        cuisine: info.cuisine || null,
        walk_minutes: Number.isFinite(info.walk_minutes) ? info.walk_minutes : null,
        menu_items: Array.isArray(info.menu_items) ? info.menu_items : [],
        note: info.note || null,
        active: true,
        verified_at: new Date().toISOString()
      };
      console.log(`  -> "${name}": ${row.menu_items.length} menu item(s) verified.`);
      rows.push(row);
    } catch (err) {
      console.error(`  -> "${name}" failed: ${err.message}`);
    }
  });

  if (rows.length === 0) {
    console.log('\nNothing verified — nothing to write.');
    return;
  }

  console.log('\n' + JSON.stringify(rows, null, 2));
  await upsertToSupabase(rows);
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
