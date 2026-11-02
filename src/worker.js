// Relais Notion en lecture seule + service des fichiers de l'app.
// Secrets requis (wrangler secret put …) : NOTION_TOKEN, APP_KEY.

const NOTION = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const ID_RE = /^[0-9a-f]{32}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });

// Comparaison à temps constant pour la clé d'app.
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function notion(env, path, init = {}) {
  const res = await fetch(NOTION + path, {
    ...init,
    headers: {
      authorization: `Bearer ${env.NOTION_TOKEN}`,
      "notion-version": NOTION_VERSION,
      "content-type": "application/json",
    },
  });
  const extra = {};
  const ra = res.headers.get("retry-after");
  if (ra) extra["retry-after"] = ra;
  return new Response(res.body, {
    status: res.status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);

    if (!env.NOTION_TOKEN || !env.APP_KEY) return json({ error: "server_not_configured" }, 500);
    if (!safeEqual(req.headers.get("x-app-key") || "", env.APP_KEY)) return json({ error: "bad_key" }, 401);

    // POST /api/search  {start_cursor?}  -> toutes les pages et bases partagées avec l'intégration
    if (url.pathname === "/api/search" && req.method === "POST") {
      let body = {};
      try { body = await req.json(); } catch {}
      const payload = { page_size: 100 };
      if (typeof body.start_cursor === "string") payload.start_cursor = body.start_cursor;
      return notion(env, "/search", { method: "POST", body: JSON.stringify(payload) });
    }

    // GET /api/blocks/:id/children?cursor=…   et   GET /api/blocks/:id
    const m = url.pathname.match(/^\/api\/blocks\/([^/]+)(\/children)?$/);
    if (m && req.method === "GET") {
      const id = m[1];
      if (!ID_RE.test(id)) return json({ error: "bad_id" }, 400);
      if (m[2]) {
        const q = new URLSearchParams({ page_size: "100" });
        const c = url.searchParams.get("cursor");
        if (c) q.set("start_cursor", c);
        return notion(env, `/blocks/${id}/children?${q}`);
      }
      return notion(env, `/blocks/${id}`);
    }

    return json({ error: "not_found" }, 404);
  },
};
