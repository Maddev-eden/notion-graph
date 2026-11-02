# Notion Graph

An Obsidian-style graph view of a Notion workspace, packaged as an installable web app (PWA) for iPhone, Android and desktop.

Every page is a node. Solid edges show the page hierarchy (parent → child), dashed edges show mentions and links between pages. The graph refreshes itself in the background and only re-reads pages that changed since the last sync.

## Features

- **Force-directed graph** (D3.js) with zoom, pan, drag, and an empty root node standing for the workspace itself
- **Two edge types**: hierarchy and mentions (`@page` mentions, `notion.so` links, *link to page* blocks)
- **Incremental sync**: hierarchy in one API call per 100 pages; mentions re-read only for pages whose `last_edited_time` changed
- **Auto-refresh**: on launch, when the app comes back to the foreground, and every 15 minutes while open
- **Offline-first UI**: the last graph is cached on the device and shown instantly
- **Search** (Enter jumps to the first match), **branch colouring**, optional **database rows**, side panel with path, sub-pages and mentions
- **Installable** on iPhone (Safari → Add to Home Screen) and Windows / macOS (Edge or Chrome → Install app)

## Architecture

```
Device (installed PWA)
        │  header: x-app-key
        ▼
Cloudflare Worker ──── serves public/ (the app)
        │  /api/*  read-only: search, blocks/:id, blocks/:id/children
        ▼
Notion API (internal integration token, never sent to the device)
```

The Notion API does not allow direct calls from a browser (CORS), so a small Worker relays a whitelist of **read-only** endpoints. The same Worker serves the static app, so there is a single deployment and a single URL.

| Path | Role |
|---|---|
| `src/worker.js` | Authenticated read-only relay to the Notion API + static asset serving |
| `public/index.html` | App shell, styles, mobile layout (safe areas, bottom sheets) |
| `public/app.js` | Sync logic (search, block-parent resolution, mention crawl) and D3 rendering |
| `public/sw.js` | Service worker: caches the app shell, never the data |
| `public/manifest.webmanifest`, `public/icons/` | PWA metadata and icons |
| `wrangler.jsonc` | Worker configuration (static assets + `/api/*` routed to the Worker) |

## Setup

### 1. Create a Notion integration

1. Open <https://www.notion.so/profile/integrations> → **New integration** → type **Internal**.
2. Under **Capabilities**, keep only **Read content**.
3. Copy the **Internal Integration Secret** (`ntn_…`).
4. Grant access to your pages: in the integration's **Access** tab, select every top-level page (sub-pages inherit access). Pages the integration cannot see do not appear in the graph.

### 2. Deploy to Cloudflare Workers (free plan)

**Option A — from GitHub (no local tooling)**

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Import a repository** → pick this repo.
2. Keep the project name `notion-graph` (it must match `name` in `wrangler.jsonc`) and deploy. Every push to `main` redeploys.

**Option B — from your machine**

```bash
npm install
npx wrangler login
npm run deploy
```

### 3. Add the two secrets

Generate an access key for the app:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

Then set the secrets, either in the dashboard (Worker → **Settings** → **Variables and Secrets**, type *Secret*) or with Wrangler:

```bash
npx wrangler secret put NOTION_TOKEN   # the ntn_… integration secret
npx wrangler secret put APP_KEY        # the generated access key
```

### 4. Install the app

| Device | Steps |
|---|---|
| iPhone | Open the Worker URL in **Safari** → Share → **Add to Home Screen** |
| Windows / macOS | Open the URL in **Edge** → `…` → **Apps** → **Install this site as an app** (Chrome: install icon in the address bar) |

On first launch, enter the `APP_KEY`. It is stored on the device only.

## Local development

Create a `.dev.vars` file (git-ignored):

```
NOTION_TOKEN=ntn_...
APP_KEY=any-local-key
```

Then run `npm run dev` and open the printed localhost URL.

## Performance and limits

- The Notion API allows about 3 requests per second; the client throttles itself accordingly. A first sync of ~200 pages takes about a minute, later syncs a few seconds.
- Mention detection is capped at 40 block requests per page, so the end of very long pages may be skipped.
- Mentions inside database rows are not analysed (rows can still be displayed as nodes).
- Pinned to Notion API version `2022-06-28`.
- Cloudflare Workers free plan: 100,000 requests per day, far above normal use.

## Security

- The Notion token lives only in Cloudflare secrets; it never reaches the device or this repository.
- The relay exposes three read-only routes and rejects any request without a valid `APP_KEY` (constant-time comparison).
- Anyone holding both the URL **and** the `APP_KEY` can read the pages shared with the integration: keep the key private, and rotate it with `wrangler secret put APP_KEY` if it leaks.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "Clé invalide" / invalid key | Wrong `APP_KEY` on the device | Settings → change key |
| "Token Notion refusé" | Wrong or revoked `NOTION_TOKEN` | Reset the secret |
| `server_not_configured` | Secrets not set yet | Step 3 |
| Empty graph or missing pages | Pages not shared with the integration | Step 1.4 |
| A page sits under the root instead of its parent | Its parent is not shared with the integration | Share the parent |

The interface is in French; the code and this documentation are in English.
