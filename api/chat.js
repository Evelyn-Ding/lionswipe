// Vercel Edge Function: multi-turn chat for Roarie, LionSwipe's food-recommendation
// chatbot. POST { messages: [{role:'user'|'assistant', content:string}], filters?: string[] }
// -> a text/event-stream of `data: {"text":"..."}` chunks (Roarie's raw JSON reply, streamed
// token-by-token) followed by `data: {"done":true}`, or `data: {"error":"..."}` on failure.
// Keeps the Anthropic API key server-side (set ANTHROPIC_API_KEY in Vercel's
// Project Settings -> Environment Variables).
export const config = { runtime: 'edge' };

// Safety cap on conversation length sent to the model. Deliberately generous (not an
// aggressive trim) so the message prefix stays stable turn-to-turn and Anthropic's
// prompt cache (see cache_control below) actually gets hits — only truly runaway
// conversations get clipped.
const MAX_HISTORY_MESSAGES = 30;

// Best-effort de-dupe cache for identical back-to-back requests (e.g. a double-tapped
// send button). Lives only as long as this Edge isolate stays warm — not a durable
// cache, just cheap insurance against firing the same Anthropic call twice.
const RECENT_RESPONSES = new Map(); // key -> { text, expires }
const RECENT_TTL_MS = 20_000;
const RECENT_MAX_ENTRIES = 50;

function pruneRecent() {
  const now = Date.now();
  for (const [key, val] of RECENT_RESPONSES) {
    if (val.expires < now) RECENT_RESPONSES.delete(key);
  }
  while (RECENT_RESPONSES.size > RECENT_MAX_ENTRIES) {
    RECENT_RESPONSES.delete(RECENT_RESPONSES.keys().next().value);
  }
}

// Pool of off-campus restaurants scripts/scrape-restaurants.js has already
// verified (real address + real current menu prices, same standard Roarie's own
// system prompt enforces) and written to Supabase on a schedule. Reading this
// lets Roarie usually skip web_search entirely — that's the actual slow part of
// a reply, since it runs before any text streams — and fall back to a live
// search only for restaurants outside the pool. Best-effort: if Supabase isn't
// configured, the table is empty, or the request fails, this just returns an
// empty list and Roarie behaves exactly as before (live search every time).
const STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
async function getCuratedRestaurants() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return [];
  try {
    const resp = await fetch(
      `${url}/rest/v1/curated_restaurants?active=eq.true&select=name,address,cuisine,walk_minutes,menu_items,note,verified_at`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    if (!resp.ok) return [];
    const rows = await resp.json();
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function curatedRestaurantsBlock(rows) {
  if (!rows.length) return '';
  const now = Date.now();
  const lines = rows.map(r => {
    const stale = r.verified_at && (now - new Date(r.verified_at).getTime()) > STALE_AFTER_MS;
    const items = (r.menu_items || []).map(mi => `${mi.item} ${mi.price}`).join(', ');
    return `- ${r.name}${r.cuisine ? ` (${r.cuisine})` : ''} — ${r.address || 'address unknown'}, ~${r.walk_minutes ?? '?'} min walk. ${r.note || ''} Menu: ${items || 'none verified'}.${stale ? ' [verified over 2 weeks ago — re-check with web_search if the student needs current prices]' : ''}`;
  }).join('\n');
  return `\n\nYou already have verified info (real address + real current menu prices, checked recently) for these nearby restaurants — prefer using this directly over web_search when one of them fits what the student wants, unless it's marked stale above:
${lines}\n`;
}

function sseStreamFromText(text) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text })}\n\n`));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
      controller.close();
    }
  });
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400 });
  }
  const { messages, filters } = body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response(JSON.stringify({ error: 'Missing messages' }), { status: 400 });
  }

  const trimmed = messages.slice(-MAX_HISTORY_MESSAGES);

  const filterText = Array.isArray(filters) && filters.length
    ? `Current filters the student has selected (apply these to any new recommendations): ${filters.join(', ')}.`
    : 'No filters currently selected.';

  pruneRecent();
  const cacheKey = JSON.stringify({ m: trimmed, f: filterText });
  const cached = RECENT_RESPONSES.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return new Response(sseStreamFromText(cached.text), {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }
    });
  }

  const curated = await getCuratedRestaurants();

  const system = `You are Roarie, LionSwipe's food-recommendation chatbot, modeled after Columbia University's lion mascot Roar-ee. You're a warm, upbeat, encouraging campus food guide helping a student near 116th St & Broadway (Morningside Heights / Harlem, NYC) figure out what to eat. Keep a friendly voice with the occasional light lion/campus touch, but stay concise and genuinely useful — don't let personality get in the way of being fast and helpful.

${filterText}
${curatedRestaurantsBlock(curated)}
When the student's message calls for new or refined restaurant suggestions, pick exactly 3 REAL nearby restaurants that fit what they're asking for. Speed matters, so be efficient:
- Prefer restaurants from the verified list above when one fits — use its info directly, no search needed.
- Only use the web_search tool for restaurants not in that list (or ones marked stale). Use at most ONE search per restaurant you do need to look up — search for something like "<restaurant name> menu prices Morningside Heights NYC", since a single Google Maps, Yelp, or delivery-app listing usually shows the address AND current menu prices together.
- Never use more than 4 searches total for one reply.
- If a restaurant was already verified earlier in this conversation, reuse what you found instead of searching it again.
- Use only prices you actually find in search results (or in the verified list above) — never guess, estimate, or recall a price from memory. If you can't verify a price for an item, leave that item out. Include each restaurant's real street address and an approximate walk time from Columbia.

If the student's message is just conversation, a clarifying question, or doesn't call for new suggestions (e.g. "what's the walk on that one?" about a place you already mentioned), don't search again — just reply, and leave recommendations empty.

Respond with ONLY raw JSON, no markdown fences and no commentary outside the JSON, in this exact shape:
{"reply": "a short 1-3 sentence conversational reply in your voice", "recommendations": [{"name":"...", "address":"...", "walk":"N min walk", "note":"one short sentence", "menu_items":[{"item":"...", "price":"$X"}]}]}
"recommendations" must be an empty array when this turn has no new suggestions.`;

  // Mark the end of the existing history as a cache breakpoint: Anthropic caches
  // everything up to and including this block, so as the conversation grows each new
  // turn only pays for (and waits on) the new user message, not the whole prefix again.
  const anthropicMessages = trimmed.map((m, i) => {
    if (i === trimmed.length - 2 && typeof m.content === 'string') {
      return { role: m.role, content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }] };
    }
    return m;
  });

  let anthropicResp;
  try {
    anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 4000,
        system,
        tools: [
          { type: 'web_search_20260209', name: 'web_search', max_uses: 4 }
        ],
        messages: anthropicMessages,
        stream: true
      })
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }

  if (!anthropicResp.ok || !anthropicResp.body) {
    let message = 'Claude API error';
    try {
      const errData = await anthropicResp.json();
      message = errData.error?.message || message;
    } catch {
      // ignore parse failure, use default message
    }
    return new Response(JSON.stringify({ error: message }), { status: 502 });
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let fullText = '';

  const stream = new ReadableStream({
    async start(controller) {
      const reader = anthropicResp.body.getReader();
      let buf = '';
      // Tracks in-progress server_tool_use (web_search) blocks by index so we can
      // surface "checking <query>..." status while the model is searching — that
      // phase runs before any reply text streams, so without this the loading
      // message just sits frozen for however long the searches take.
      const pendingSearches = new Map(); // index -> accumulated partial_json string
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6);
            if (payload === '[DONE]') continue;
            let evt;
            try {
              evt = JSON.parse(payload);
            } catch {
              continue;
            }
            if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
              fullText += evt.delta.text;
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: evt.delta.text })}\n\n`));
            } else if (evt.type === 'content_block_start' && evt.content_block?.type === 'server_tool_use' && evt.content_block?.name === 'web_search') {
              pendingSearches.set(evt.index, '');
            } else if (evt.type === 'content_block_delta' && evt.delta?.type === 'input_json_delta' && pendingSearches.has(evt.index)) {
              pendingSearches.set(evt.index, pendingSearches.get(evt.index) + (evt.delta.partial_json || ''));
            } else if (evt.type === 'content_block_stop' && pendingSearches.has(evt.index)) {
              const raw = pendingSearches.get(evt.index);
              pendingSearches.delete(evt.index);
              let query = null;
              try { query = JSON.parse(raw).query; } catch { /* incomplete/malformed, skip */ }
              if (query) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ status: `Checking "${query}"...` })}\n\n`));
              }
            } else if (evt.type === 'error') {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: evt.error?.message || 'stream error' })}\n\n`));
            }
          }
        }
        if (fullText) {
          pruneRecent();
          RECENT_RESPONSES.set(cacheKey, { text: fullText, expires: Date.now() + RECENT_TTL_MS });
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
      } catch (err) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: err.message })}\n\n`));
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }
  });
}
