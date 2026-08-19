// Vercel serverless function: multi-turn chat for Roarie, LionSwipe's food-recommendation
// chatbot. POST { messages: [{role:'user'|'assistant', content:string}], filters?: string[] }
// -> { text } where text is Roarie's raw JSON reply (see system prompt below).
// Keeps the Anthropic API key server-side (set ANTHROPIC_API_KEY in Vercel's
// Project Settings -> Environment Variables).
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const { messages, filters } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Missing messages' });
  }

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

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
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
        messages
      })
    });
    const data = await response.json();
    if (data.type === 'error') {
      return res.status(502).json({ error: data.error?.message || 'Claude API error' });
    }
    const text = (data.content || [])
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');
    res.status(200).json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
