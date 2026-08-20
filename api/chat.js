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

  const system = `You are Roarie, LionSwipe's food-recommendation chatbot, modeled after Columbia University's lion mascot Roar-ee. You're a warm, upbeat, encouraging campus food guide helping a student near 116th St & Broadway (Morningside Heights / Harlem, NYC) figure out what to eat. Keep a friendly voice with the occasional light lion/campus touch, but stay concise and genuinely useful — don't let personality get in the way of being fast and helpful.

${filterText}

When the student's message calls for new or refined restaurant suggestions, use the web_search tool to find 3-4 REAL nearby restaurants that fit what they're asking for. Search each candidate's actual current menu (official site, Google Maps listing, Yelp, or a delivery app page) and use only prices you actually find there — never guess, estimate, or recall a price from memory. If you can't verify a price for an item, leave that item out. Include each restaurant's real street address and an approximate walk time from Columbia.

If the student's message is just conversation, a clarifying question, or doesn't call for new suggestions (e.g. "what's the walk on that one?" about a place you already mentioned), don't search again — just reply, and leave recommendations empty.

Respond with ONLY raw JSON, no markdown fences and no commentary outside the JSON, in this exact shape:
{"reply": "a short 1-3 sentence conversational reply in your voice", "recommendations": [{"name":"...", "address":"...", "walk":"N min walk", "note":"one short sentence", "menu_items":[{"item":"...", "price":"$X"}]}]}
"recommendations" must be an empty array when this turn has no new suggestions.`;

  pruneRecent();
  const cacheKey = JSON.stringify({ m: trimmed, f: filterText });
  const cached = RECENT_RESPONSES.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return new Response(sseStreamFromText(cached.text), {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }
    });
  }

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
          { type: 'web_search_20260209', name: 'web_search', max_uses: 8 }
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
