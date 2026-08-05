// Vercel serverless function: GET -> today's menus per meal period per dining hall.
//
// dining.columbia.edu sits behind a Cloudflare JS challenge ("Just a moment...")
// that blocks plain server-side HTTP requests — a bare `fetch()` from here gets a
// 403 challenge page, not menu HTML. So this function never scrapes the site
// itself. Instead, scripts/scrape-menus.js runs on a schedule (outside Vercel,
// using a real/headless browser) and writes the day's menus into the Supabase
// `daily_menus` table (see schema.sql). This function just reads that table with
// the same public anon key the rest of the app uses, and falls back to curated
// sample data if today's row isn't there yet (scraper hasn't run, or hasn't been
// wired up to real selectors yet — see the TODO in scripts/scrape-menus.js).

const SAMPLE_MENUS = {
  Breakfast: {
    "Ferris": { hours: "7:00 AM – 10:00 AM", stations: [
      { name: "Main Line", items: ["Scrambled Eggs", "Turkey Bacon", "Home Fries"] },
      { name: "Bakery", items: ["Assorted Muffins", "Bagels & Cream Cheese"] }
    ]},
    "JJ's": { hours: "9:00 AM – 12:00 AM", stations: [
      { name: "Grill", items: ["Bacon Egg & Cheese", "Hash Browns"] }
    ]},
    "Faculty House": { closed: true },
    "Grace Dodge": { hours: "7:30 AM – 10:00 AM", stations: [
      { name: "Hot Station", items: ["Oatmeal Bar", "Pancakes"] }
    ]}
  },
  Lunch: {
    "Ferris": { hours: "11:00 AM – 3:00 PM", stations: [
      { name: "Main Line", items: ["Grilled Chicken", "Rice Pilaf", "Roasted Vegetables"] },
      { name: "Action Station", items: ["Build-Your-Own Bowl"] }
    ]},
    "JJ's": { hours: "12:00 PM – midnight", stations: [
      { name: "Main Line", items: ["Cilantro Lime Rice", "Black Beans", "Chicken Quesadilla"] }
    ]},
    "Faculty House": { hours: "11:30 AM – 2:00 PM", stations: [
      { name: "Buffet", items: ["Seasonal Salad Bar", "Pasta Primavera"] }
    ]},
    "Grace Dodge": { hours: "11:00 AM – 2:00 PM", stations: [
      { name: "Hot Station", items: ["Turkey Club", "Tomato Soup"] }
    ]}
  },
  Dinner: {
    "Ferris": { hours: "5:00 PM – 8:30 PM", stations: [
      { name: "Main Line", items: ["Roasted Chicken", "Pan Roasted Sprouts"] },
      { name: "Action Station", items: ["Stir Fry Bar"] }
    ]},
    "JJ's": { hours: "12:00 PM – midnight", stations: [
      { name: "Main Line", items: ["Cilantro Lime Rice", "Black Beans", "Citrus Peanuts"] }
    ]},
    "Faculty House": { closed: true },
    "Grace Dodge": { hours: "5:00 PM – 8:00 PM", stations: [
      { name: "Hot Station", items: ["Ramen Bar"] }
    ]}
  },
  "Late Night": {
    "Ferris": { closed: true },
    "JJ's": { hours: "10:00 PM – 2:00 AM", stations: [
      { name: "Grill", items: ["Mozzarella Sticks", "Late Night Fries"] }
    ]},
    "Faculty House": { closed: true },
    "Grace Dodge": { closed: true }
  }
};

async function getMenus() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return SAMPLE_MENUS;

  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
    const resp = await fetch(
      `${url}/rest/v1/daily_menus?date=eq.${today}&select=menus`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    if (!resp.ok) return SAMPLE_MENUS;
    const rows = await resp.json();
    return (rows && rows[0] && rows[0].menus) || SAMPLE_MENUS;
  } catch (err) {
    console.error('daily_menus lookup failed, using sample data:', err.message);
    return SAMPLE_MENUS;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const menus = await getMenus();
    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=1800');
    res.status(200).json(menus);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
