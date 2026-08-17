// Vercel serverless function: POST { prompt } -> Claude's raw text response.
// Keeps the Anthropic API key server-side (set ANTHROPIC_API_KEY in Vercel's
// Project Settings -> Environment Variables).
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const { prompt } = req.body || {};
  if (!prompt) {
    return res.status(400).json({ error: 'Missing prompt' });
  }

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
        tools: [
          { type: 'web_search_20260209', name: 'web_search', max_uses: 8 }
        ],
        messages: [{ role: 'user', content: prompt }]
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
