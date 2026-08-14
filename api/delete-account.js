// Vercel serverless function: POST (Authorization: Bearer <user's access token>) ->
// permanently deletes the caller's own Supabase Auth account. Requires the service
// role key (server-side only, set in Vercel/`.env` — never shipped to the browser)
// to call the Auth Admin API; meal_logs/meal_plans rows are removed automatically
// via the `on delete cascade` foreign keys in schema.sql.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) {
    return res.status(401).json({ error: 'Missing auth token' });
  }

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    return res.status(500).json({ error: 'Server is not configured for account deletion (missing SUPABASE_SERVICE_ROLE_KEY)' });
  }

  try {
    // Resolve the caller's own user id from their access token server-side —
    // never trust a client-supplied id, or anyone could delete another account.
    const whoResp = await fetch(`${url}/auth/v1/user`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${token}` }
    });
    if (!whoResp.ok) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }
    const who = await whoResp.json();
    if (!who.id) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    const delResp = await fetch(`${url}/auth/v1/admin/users/${who.id}`, {
      method: 'DELETE',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }
    });
    if (!delResp.ok) {
      const text = await delResp.text();
      return res.status(500).json({ error: 'Could not delete account: ' + text });
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
