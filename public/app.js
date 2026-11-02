(() => {
  "use strict";
  const ROOT = "__root__";
  const TRUNK = "__trunk__";
  const STORE = "notion-graph-app-v1";
  const KEY_STORE = "notion-graph-key";
  const AUTO_MS = 15 * 60 * 1000;   // re-synchronisation toutes les 15 min quand l'app est visible
  const CONCURRENCY = 3;
  const MIN_GAP_MS = 340;           // ~3 requêtes/s : limite moyenne de l'API Notion
  const MAX_BLOCK_CALLS = 40;       // plafond d'appels par page pour la recherche de mentions
  const PALETTE = ["#3987e5","#d95926","#199e70","#c98500","#d55181","#9085e9","#e66767"]; // palette catégorielle validée (mode sombre)
  const OTHER = "#6a6a64";

  const $ = id => document.getElementById(id);
  const statusEl = $("status"), statusText = $("statusText");
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const idOf = s => { const m = String(s || "").replace(/-/g, "").match(/([0-9a-f]{32})(?![0-9a-f])/i); return m ? m[1].toLowerCase() : null; };
  const setStatus = (t, kind) => { statusText.textContent = t; statusEl.className = kind || ""; statusEl.title = t; };
  const ago = ts => { if (!ts) return "jamais"; const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return "à l'instant"; if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
    if (s < 86400) return `il y a ${Math.round(s / 3600)} h`; if (s < 30 * 86400) return `il y a ${Math.round(s / 86400)} j`;
    return "le " + new Date(ts).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" }); };

  // ---------------- état ----------------
  // nodes: id -> {id,title,icon,url,type:'page'|'database'|'row'|'root',parent,edited,branch}
  // mentions: id -> {edited, ids:[...]}   (cache incrémental : une page n'est relue que si elle a changé)
  // blockParents: blockId -> parentId (résolution des pages placées dans un bloc)
  let nodes = new Map(), mentions = {}, blockParents = {}, lastUpdated = null;
  let syncing = false;
  let key = null;

  function save() {
    try {
      localStorage.setItem(STORE, JSON.stringify({ at: lastUpdated, nodes: [...nodes.values()], mentions, blockParents }));
    } catch (e) { /* quota ou stockage indisponible : on continue sans cache */ }
  }
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE) || "null");
      if (!s) return false;
      nodes = new Map(s.nodes.map(n => [n.id, n])); mentions = s.mentions || {}; blockParents = s.blockParents || {}; lastUpdated = s.at;
      return true;
    } catch (e) { return false; }
  }
  try { key = localStorage.getItem(KEY_STORE); } catch (e) {}

  // ---------------- API (via le relais) ----------------
  class AuthError extends Error {}
  let lastCall = 0;
  async function api(path, init = {}, attempt = 0) {
    const wait = lastCall + MIN_GAP_MS - Date.now();
    lastCall = Math.max(Date.now(), lastCall + MIN_GAP_MS);
    if (wait > 0) await sleep(wait);
    let res;
    try {
      res = await fetch(path, { ...init, headers: { "content-type": "application/json", "x-app-key": key || "" } });
    } catch (e) {
      if (attempt < 1) { await sleep(1500); return api(path, init, attempt + 1); }
      throw new Error("offline");
    }
    if (res.status === 401) {
      const b = await res.json().catch(() => ({}));
      if (b.error === "bad_key") throw new AuthError("bad_key");
      throw new Error("notion_unauthorized");     // token Notion invalide
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt < 3) {
        const ra = Number(res.headers.get("retry-after"));
        await sleep((ra > 0 ? ra * 1000 : 1000 * (attempt + 1)) + Math.random() * 400);
        return api(path, init, attempt + 1);
      }
      throw new Error("http_" + res.status);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { const err = new Error(body.code || body.error || "http_" + res.status); err.status = res.status; throw err; }
    return body;
  }

  const titleOf = item => {
    if (item.object === "database") return (item.title || []).map(t => t.plain_text).join("").trim() || "Base sans titre";
    const props = item.properties || {};
    for (const k in props) if (props[k] && props[k].type === "title")
      return (props[k].title || []).map(t => t.plain_text).join("").trim() || "Sans titre";
    return "Sans titre";
  };
  const iconOf = item => item.icon && item.icon.type === "emoji" ? item.icon.emoji : null;
  const rawParent = p => !p ? null : p.type === "workspace" ? ROOT : p.type === "block_id" ? { block: idOf(p.block_id) } : idOf(p.page_id || p.database_id || p.data_source_id);

  async function resolveBlockParent(blockId) {
    let cur = blockId;
    for (let i = 0; i < 6; i++) {
      if (blockParents[cur] !== undefined) return blockParents[cur];
      const b = await api(`/api/blocks/${cur}`);
      const p = rawParent(b.parent);
      if (p && typeof p === "object" && p.block) { cur = p.block; continue; }
      blockParents[blockId] = p || ROOT;
      return blockParents[blockId];
    }
    return ROOT;
  }

  function collectRich(arr, out) {
    for (const r of arr || []) {
      if (r.type === "mention" && r.mention) {
        const id = idOf((r.mention.page || {}).id || (r.mention.database || {}).id);
        if (id) out.add(id);
      }
      if (r.href && /notion\.(so|site|com)/.test(r.href)) { const id = idOf(r.href); if (id) out.add(id); }
    }
  }
  async function pageMentions(pageId) {
    const out = new Set();
    const stack = [pageId];
    let calls = 0;
    while (stack.length && calls < MAX_BLOCK_CALLS) {
      const blockId = stack.pop();
      let cursor = null;
      do {
        if (calls++ >= MAX_BLOCK_CALLS) break;
        const res = await api(`/api/blocks/${blockId}/children` + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""));
        for (const b of res.results || []) {
          const v = b[b.type] || {};
          collectRich(v.rich_text, out);
          collectRich(v.caption, out);
          if (b.type === "table_row") for (const cell of v.cells || []) collectRich(cell, out);
          if (b.type === "link_to_page") { const id = idOf(v.page_id || v.database_id); if (id) out.add(id); }
          if ((b.type === "bookmark" || b.type === "embed" || b.type === "link_preview") && /notion\.(so|site|com)/.test(v.url || "")) {
            const id = idOf(v.url); if (id) out.add(id);
          }
          if (b.has_children && b.type !== "child_page" && b.type !== "child_database") stack.push(b.id);
        }
        cursor = res.has_more ? res.next_cursor : null;
      } while (cursor);
    }
    out.delete(pageId);
    return [...out];
  }

  // ---------------- synchronisation ----------------
  async function sync({ full = false } = {}) {
    if (syncing || !key) return;
    syncing = true; $("bRefresh").disabled = true;
    let failed = 0;
    try {
      // 1) Hiérarchie : la recherche renvoie chaque page avec son parent (100 par appel)
      setStatus("Liste des pages…", "busy");
      const items = []; let cursor;
      do {
        const res = await api("/api/search", { method: "POST", body: JSON.stringify(cursor ? { start_cursor: cursor } : {}) });
        items.push(...(res.results || []));
        cursor = res.has_more ? res.next_cursor : null;
        setStatus(`Liste des pages… ${items.length}`, "busy");
      } while (cursor);

      const nN = new Map([[ROOT, { id: ROOT, title: "", type: "root", parent: null, branch: ROOT }]]);
      const pendingBlocks = [];
      for (const it of items) {
        if (it.archived || it.in_trash) continue;
        const id = idOf(it.id); if (!id) continue;
        const p = rawParent(it.parent);
        const n = {
          id, title: titleOf(it), icon: iconOf(it), url: it.url,
          type: it.object === "database" ? "database" : (it.parent && (it.parent.type === "database_id" || it.parent.type === "data_source_id")) ? "row" : "page",
          edited: it.last_edited_time, parent: typeof p === "string" ? p : ROOT,
        };
        if (p && typeof p === "object") pendingBlocks.push([n, p.block]);
        nN.set(id, n);
      }
      for (const [n, b] of pendingBlocks) {
        try { n.parent = await resolveBlockParent(b); } catch (e) { if (e instanceof AuthError) throw e; n.parent = ROOT; }
      }
      for (const n of nN.values()) if (n.id !== ROOT && !nN.has(n.parent)) n.parent = ROOT; // parent non partagé avec l'intégration
      computeBranches(nN);
      nodes = nN; onData();

      // 2) Mentions : seulement les pages modifiées depuis la dernière lecture
      if (full) mentions = {};
      for (const id of Object.keys(mentions)) if (!nodes.has(id)) delete mentions[id];
      const todo = [...nodes.values()].filter(n => n.type === "page" && (!mentions[n.id] || mentions[n.id].edited !== n.edited)).map(n => n.id);
      let done = 0;
      const worker = async () => {
        while (todo.length) {
          const id = todo.shift();
          try { mentions[id] = { edited: nodes.get(id).edited, ids: await pageMentions(id) }; }
          catch (e) { if (e instanceof AuthError) throw e; failed++; }
          done++;
          setStatus(`Mentions ${done}/${done + todo.length}…`, "busy");
          if (done % 25 === 0) { onData(); save(); }
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));

      lastUpdated = Date.now(); save(); onData();
      setStatus(summary() + (failed ? ` · ${failed} illisibles` : ""));
    } catch (e) {
      if (e instanceof AuthError) { askKey("Clé refusée par le serveur."); setStatus("Clé invalide", "err"); }
      else if (e.message === "notion_unauthorized") setStatus("Token Notion refusé (voir README)", "err");
      else if (e.message === "offline") setStatus(`Hors ligne · version du ${ago(lastUpdated)}`, "err");
      else setStatus(`Erreur (${e.message}) · version du ${ago(lastUpdated)}`, "err");
    } finally {
      syncing = false; $("bRefresh").disabled = false; if (!statusEl.classList.contains("err")) statusEl.className = "";
    }
  }
  const summary = () => {
    const pages = [...nodes.values()].filter(n => n.id !== ROOT && n.type !== "row").length;
    const shown = lastView ? lastView.ns.filter(n => n.id !== ROOT).length : 0;
    const total = [...nodes.values()].filter(n => n.id !== ROOT).length;
    const filtered = lastView && $("fBadge").classList.contains("show");
    return `${pages} pages` + (filtered ? ` · ${shown} affichées` : "") + ` · màj ${ago(lastUpdated)}`;
  };
  // Branche = ancêtre au premier niveau qui se divise vraiment : si une seule page est à la racine
  // (ex. tout rangé sous « Second-Brain »), on colore par ses enfants plutôt que tout en une couleur.
  function computeBranches(map) {
    const kids = new Map();
    for (const n of map.values()) if (n.id !== ROOT) kids.set(n.parent, (kids.get(n.parent) || 0) + 1);
    let top = ROOT, guard = 0;
    while (kids.get(top) === 1 && guard++ < 10) top = [...map.values()].find(n => n.parent === top && n.id !== ROOT).id;
    for (const n of map.values()) {
      if (n.id === ROOT) { n.branch = ROOT; continue; }
      let cur = n, g = 0;
      while (cur && cur.parent && cur.parent !== top && cur.parent !== ROOT && g++ < 60) cur = map.get(cur.parent);
      // pages de la chaîne racine (ex. Second-Brain lui-même) : neutres, hors légende
      n.branch = cur && cur.parent === top ? cur.id : TRUNK;
    }
  }

  // =====================================================================
  //  Réglages (persistés sur l'appareil)
  // =====================================================================
  const SETTINGS_STORE = "notion-graph-settings-v1";
  const DEFAULTS = {
    searchMode: "highlight", maxDepth: 0, recency: 0,
    typePage: true, typeDb: true, typeRow: false, linkedOnly: false, keepPath: true, hiddenBranches: [],
    local: false, localDepth: 1,
    labels: "auto", labelMin: 6, declutter: true, fontSize: 11, showIcons: true,
    colorBy: "branch", sizeBy: "degree", nodeScale: 1, showTree: true, showLinks: true, edgeWidth: 1,
    repel: 90, linkDist: 40, gravity: 0.03,
  };
  let S = { ...DEFAULTS };
  try { Object.assign(S, JSON.parse(localStorage.getItem(SETTINGS_STORE) || "{}")); } catch (e) {}
  const saveSettings = () => { try { localStorage.setItem(SETTINGS_STORE, JSON.stringify(S)); } catch (e) {} };

  // Quels réglages déclenchent quoi : recalcul de la vue, simple restyle, forces ou titres.
  const STRUCT = new Set(["searchMode","maxDepth","recency","typePage","typeDb","typeRow","linkedOnly","keepPath","hiddenBranches","local","localDepth","showTree","showLinks"]);
  const STYLE = new Set(["colorBy","sizeBy","nodeScale","edgeWidth","showIcons"]);
  const FORCES = new Set(["repel","linkDist","gravity"]);
  const LABELS = new Set(["labels","labelMin","declutter","fontSize"]);

  // =====================================================================
  //  Données dérivées (recalculées à chaque synchronisation)
  // =====================================================================
  let lastView = null;
  let D = { children: new Map(), mOut: new Map(), mIn: new Map(), branches: [], branchColor: new Map(), maxDepth: 1, newest: 0, oldest: 0 };

  function derive() {
    const children = new Map(), mOut = new Map(), mIn = new Map();
    for (const n of nodes.values()) {
      if (n.id === ROOT) continue;
      if (!children.has(n.parent)) children.set(n.parent, []);
      children.get(n.parent).push(n.id);
    }
    // profondeur depuis la racine
    const root = nodes.get(ROOT); if (root) root.depth = 0;
    const stack = [[ROOT, 0]]; let maxDepth = 1;
    while (stack.length) {
      const [id, d] = stack.pop();
      for (const c of children.get(id) || []) { const n = nodes.get(c); n.depth = d + 1; maxDepth = Math.max(maxDepth, d + 1); stack.push([c, d + 1]); }
    }
    // nombre de descendants (post-ordre)
    const desc = id => { let s = 0; for (const c of children.get(id) || []) s += 1 + desc(c); nodes.get(id).desc = s; return s; };
    desc(ROOT);
    // mentions, hors relation parent/enfant
    for (const [a, m] of Object.entries(mentions)) for (const b of m.ids) {
      if (a === b || !nodes.has(a) || !nodes.has(b)) continue;
      if (nodes.get(b).parent === a || nodes.get(a).parent === b) continue;
      if (!mOut.has(a)) mOut.set(a, new Set()); mOut.get(a).add(b);
      if (!mIn.has(b)) mIn.set(b, new Set()); mIn.get(b).add(a);
    }
    // branches : couleur fixe pour les 7 plus grosses (ordonnées par titre, pas par rang), le reste « Autres »
    // comptage par type : les lignes de bases (souvent des centaines d'entrées de tracker) ne doivent pas écraser le reste
    const counts = new Map();
    for (const n of nodes.values()) if (n.id !== ROOT && n.branch !== TRUNK) {
      if (!counts.has(n.branch)) counts.set(n.branch, { page: 0, database: 0, row: 0 });
      counts.get(n.branch)[n.type] = (counts.get(n.branch)[n.type] || 0) + 1;
    }
    const branches = [...counts].map(([id, c]) => ({ id, c, base: c.page + c.database, title: nodes.get(id)?.title || "?",
      get count() { return (S.typePage ? c.page : 0) + (S.typeDb ? c.database : 0) + (S.typeRow ? c.row : 0); } }))
      .sort((a, b) => b.base - a.base);
    const colored = branches.slice(0, PALETTE.length).map(b => b.id).sort((a, b) => nodes.get(a).title.localeCompare(nodes.get(b).title));
    const branchColor = new Map(colored.map((id, i) => [id, PALETTE[i]]));
    const times = [...nodes.values()].map(n => Date.parse(n.edited)).filter(Number.isFinite);
    D = { children, mOut, mIn, branches, branchColor, maxDepth,
          newest: times.length ? Math.max(...times) : Date.now(), oldest: times.length ? Math.min(...times) : Date.now() };
    $("dataInfo").textContent = `${nodes.size - 1} éléments · ${[...mOut.values()].reduce((s, x) => s + x.size, 0)} mentions · profondeur ${maxDepth} · màj ${ago(lastUpdated)}`;
    const md = document.querySelector('input[data-k="maxDepth"]'); md.max = String(maxDepth);
    if (S.maxDepth > maxDepth) S.maxDepth = 0;
  }

  // =====================================================================
  //  Vue filtrée
  // =====================================================================
  let selectedId = null, hoverId = null, query = "";

  function computeView() {
    const q = query.trim().toLowerCase();
    const hidden = new Set(S.hiddenBranches);
    const minTime = S.recency ? Date.now() - S.recency * 86400000 : 0;
    const typeOk = n => n.type === "page" ? S.typePage : n.type === "database" ? S.typeDb : n.type === "row" ? S.typeRow : true;
    const linked = id => (D.mOut.get(id)?.size || 0) + (D.mIn.get(id)?.size || 0) > 0;
    const pass = n => n.id !== ROOT && typeOk(n)
      && (!S.maxDepth || n.depth <= S.maxDepth)
      && (!minTime || Date.parse(n.edited) >= minTime)
      && (n.branch === TRUNK || !hidden.has(n.branch))
      && (!S.linkedOnly || linked(n.id))
      && (S.searchMode !== "filter" || !q || n.title.toLowerCase().includes(q));
    let base = new Set([...nodes.values()].filter(pass).map(n => n.id));
    if (selectedId && nodes.has(selectedId)) base.add(selectedId); // la page sélectionnée reste visible même filtrée

    // graphe local : voisinage de la page sélectionnée (liens visibles), rayon N
    if (S.local && selectedId && nodes.has(selectedId)) {
      const pool = new Set([...nodes.values()].filter(n => n.id !== ROOT && typeOk(n)).map(n => n.id));
      const reach = new Set([selectedId]); let frontier = [selectedId];
      for (let d = 0; d < S.localDepth; d++) {
        const next = [];
        for (const id of frontier) {
          const n = nodes.get(id), nb = [];
          if (S.showTree) { if (n.parent && n.parent !== ROOT) nb.push(n.parent); nb.push(...(D.children.get(id) || [])); }
          if (S.showLinks) nb.push(...(D.mOut.get(id) || []), ...(D.mIn.get(id) || []));
          for (const x of nb) if (pool.has(x) && !reach.has(x)) { reach.add(x); next.push(x); }
        }
        frontier = next;
      }
      base = new Set([...reach].filter(id => base.has(id) || id === selectedId));
    }

    // chemin vers la racine pour garder une structure lisible
    const ctx = new Set();
    if (S.keepPath && !S.local) for (const id of base) {
      let p = nodes.get(id).parent, g = 0;
      while (p && p !== ROOT && !base.has(p) && g++ < 60) { ctx.add(p); p = nodes.get(p)?.parent; }
    }
    const vis = new Set([...base, ...ctx]);
    if ([...vis].some(id => nodes.get(id).parent === ROOT)) vis.add(ROOT);

    const es = [];
    if (S.showTree) for (const id of vis) { const p = nodes.get(id).parent; if (id !== ROOT && vis.has(p)) es.push({ source: p, target: id, kind: "tree" }); }
    if (S.showLinks) {
      const seen = new Set();
      for (const a of vis) for (const b of D.mOut.get(a) || []) {
        if (!vis.has(b)) continue;
        const k = a < b ? a + b : b + a; if (seen.has(k)) continue; seen.add(k);
        es.push({ source: a, target: b, kind: "link" });
      }
    }
    const match = new Set(q && S.searchMode === "highlight" ? [...vis].filter(id => id !== ROOT && nodes.get(id).title.toLowerCase().includes(q)) : []);
    const deg = new Map();
    for (const e of es) { deg.set(e.source, (deg.get(e.source) || 0) + 1); deg.set(e.target, (deg.get(e.target) || 0) + 1); }
    const adj = new Map();
    for (const e of es) {
      if (!adj.has(e.source)) adj.set(e.source, new Set()); if (!adj.has(e.target)) adj.set(e.target, new Set());
      adj.get(e.source).add(e.target); adj.get(e.target).add(e.source);
    }
    return { ns: [...vis].map(id => nodes.get(id)), es, ctx, match, deg, adj };
  }

  // =====================================================================
  //  Rendu D3
  // =====================================================================
  const svg = d3.select("#g");
  const world = svg.append("g");
  const gEdges = world.append("g"), gNodes = world.append("g");
  let T = d3.zoomIdentity, simNodes = new Map(), frozen = false;
  const zoom = d3.zoom().scaleExtent([0.05, 8]).on("zoom", ev => { T = ev.transform; world.attr("transform", T); scheduleLabels(); });
  svg.call(zoom).on("dblclick.zoom", null);
  svg.on("click", ev => { if (ev.target === svg.node()) { select(null); } });

  const sim = d3.forceSimulation().stop()
    .force("link", d3.forceLink().id(d => d.id))
    .force("charge", d3.forceManyBody())
    .force("collide", d3.forceCollide())
    .force("x", d3.forceX()).force("y", d3.forceY());
  let tickCount = 0;
  sim.on("tick", () => { ticked(); if (++tickCount % 8 === 0) scheduleLabels(); });
  sim.on("end", () => { scheduleLabels(); if (pendingFit) { pendingFit = false; fit(700); } });
  let pendingFit = false;

  function applyForces() {
    sim.force("link").distance(d => d.kind === "tree" ? S.linkDist : S.linkDist * 2.2).strength(d => d.kind === "tree" ? .7 : .12);
    sim.force("charge").strength(d => d.id === ROOT ? -S.repel * 3 : -S.repel).distanceMax(600);
    sim.force("collide").radius(d => radius(d) + 3);
    sim.force("x").x(innerWidth / 2).strength(S.gravity);
    sim.force("y").y(innerHeight / 2).strength(S.gravity);
  }

  // échelles de couleur
  const seq = d3.interpolateRgb("#2a4a73", "#a8cdff"); // une teinte, sombre → clair (clair = plus important)
  const TYPE_COL = { page: PALETTE[0], database: PALETTE[1], row: PALETTE[2] };
  function colorOf(d) {
    if (d.id === ROOT) return "none";
    switch (S.colorBy) {
      case "branch": return d.branch === TRUNK ? "var(--node)" : (D.branchColor.get(d.branch) || OTHER);
      case "depth": return seq(D.maxDepth <= 1 ? 1 : 1 - (d.depth - 1) / (D.maxDepth - 1));
      case "recency": {
        const t = Date.parse(d.edited); if (!Number.isFinite(t)) return OTHER;
        const span = Math.log1p((D.newest - D.oldest) / 86400000) || 1;
        return seq(1 - Math.log1p((D.newest - t) / 86400000) / span);
      }
      case "type": return TYPE_COL[d.type] || OTHER;
      default: return "var(--node)";
    }
  }
  function radius(d) {
    if (d.id === ROOT) return 7;
    const v = lastView;
    const r = S.sizeBy === "uniform" ? 4.5
      : S.sizeBy === "descendants" ? 3 + Math.sqrt(d.desc || 0) * 1.3
      : 3 + Math.sqrt((v && v.deg.get(d.id)) || 1) * 1.6;
    return r * S.nodeScale;
  }
  const labelText = d => d.id === ROOT ? "" : ((S.showIcons && d.icon ? d.icon + " " : "") + d.title);

  let eSel = gEdges.selectAll("line"), nSel = gNodes.selectAll("g.node");
  function refresh({ reheat = 0.35 } = {}) {
    const v = computeView(); lastView = v;
    const W = innerWidth, H = innerHeight;
    const ns = v.ns.map(n => {
      let o = simNodes.get(n.id);
      if (!o) {
        const p = simNodes.get(n.parent); // naît près de son parent : la disposition reste stable
        o = { x: (p ? p.x : W / 2) + (Math.random() - .5) * 40, y: (p ? p.y : H / 2) + (Math.random() - .5) * 40 };
      }
      return Object.assign(o, n);
    });
    simNodes = new Map([...simNodes, ...ns.map(n => [n.id, n])]);
    const es = v.es.map(e => ({ ...e }));

    eSel = gEdges.selectAll("line").data(es, d => d.kind + (d.source.id || d.source) + "|" + (d.target.id || d.target))
      .join("line").attr("class", d => "edge " + d.kind).attr("vector-effect", "non-scaling-stroke");
    nSel = gNodes.selectAll("g.node").data(ns, d => d.id).join(enter => {
        const g = enter.append("g").attr("class", "node");
        g.append("circle").attr("vector-effect", "non-scaling-stroke");
        g.append("text").attr("text-anchor", "middle");
        return g;
      })
      .call(drag)
      .on("mouseenter", (ev, d) => { if (ev.pointerType === "touch") return; hoverId = d.id; highlight(); tip(ev, d); })
      .on("mousemove", (ev, d) => tip(ev, d))
      .on("mouseleave", () => { hoverId = null; highlight(); $("tip").style.display = "none"; })
      .on("click", (ev, d) => { ev.stopPropagation(); if (d.id !== ROOT) select(d.id); });

    sim.nodes(ns); sim.force("link").links(es); applyForces();
    restyle();
    if (!frozen) sim.alpha(Math.max(sim.alpha(), reheat)).restart(); else { ticked(); }
    $("empty").style.display = ns.filter(n => n.id !== ROOT).length ? "none" : "flex";
    updateBadge(); renderLegend(); renderBranchList();
    if (!syncing && lastUpdated) setStatus(summary());
    if (selectedId) renderInfo();
  }

  function restyle() {
    const v = lastView;
    nSel.attr("class", d => `node ${d.type}${v.ctx.has(d.id) ? " ctx" : ""}${v.match.has(d.id) ? " match" : ""}${d.id === selectedId ? " sel" : ""}`);
    nSel.select("circle").attr("r", radius).attr("fill", colorOf);
    nSel.select("text").text(labelText);
    eSel.style("stroke-width", d => (d.kind === "tree" ? 1 : 1.1) * S.edgeWidth);
    sim.force("collide").radius(d => radius(d) + 3);
    highlight();
  }

  function ticked() {
    eSel.attr("x1", d => d.source.x).attr("y1", d => d.source.y).attr("x2", d => d.target.x).attr("y2", d => d.target.y);
    nSel.attr("transform", d => `translate(${d.x},${d.y})`);
  }

  const drag = d3.drag()
    .on("start", (ev, d) => { if (!ev.active && !frozen) sim.alphaTarget(.2).restart(); d.fx = d.x; d.fy = d.y; })
    .on("drag", (ev, d) => { d.fx = ev.x; d.fy = ev.y; if (frozen) { d.x = ev.x; d.y = ev.y; ticked(); scheduleLabels(); } })
    .on("end", (ev, d) => { if (!ev.active && !frozen) sim.alphaTarget(0); if (!frozen) { d.fx = null; d.fy = null; } });

  // ---------- titres : importance, zoom et anti-chevauchement ----------
  let labelRaf = 0;
  const scheduleLabels = () => { if (!labelRaf) labelRaf = requestAnimationFrame(() => { labelRaf = 0; placeLabels(); }); };
  function importance(d) {
    const v = lastView;
    return ((v && v.deg.get(d.id)) || 0) + Math.sqrt(d.desc || 0) * 1.5 + (d.id === d.branch || d.parent === ROOT ? 40 : 0);
  }
  function placeLabels() {
    const v = lastView; if (!v) return;
    const k = T.k, fs = S.fontSize;
    const focus = hoverId || selectedId;
    const near = focus ? (v.adj.get(focus) || new Set()) : null;
    const forced = d => d.id === focus || (near && near.has(d.id)) || v.match.has(d.id);
    const threshold = S.labelMin / Math.max(k, 0.15) ** 1.15;
    const cand = [];
    nSel.each(function (d) {
      if (d.id === ROOT) return;
      let want = forced(d);
      if (!want && !(near)) {
        if (S.labels === "all") want = true;
        else if (S.labels === "auto") want = importance(d) >= threshold && !v.ctx.has(d.id);
      }
      if (want) cand.push(d);
    });
    let keep = cand;
    if (S.declutter && S.labels !== "all") {
      cand.sort((a, b) => (forced(b) - forced(a)) || importance(b) - importance(a));
      const boxes = []; keep = [];
      const W = innerWidth, H = innerHeight;
      for (const d of cand) {
        const sx = d.x * k + T.x, sy = d.y * k + T.y + radius(d) * k + fs * 1.1;
        const w = labelText(d).length * fs * 0.56 + 6, h = fs * 1.3;
        if (sx < -w || sx > W + w || sy < -h || sy > H + h) continue; // hors écran : inutile
        const b = [sx - w / 2, sy - h, sx + w / 2, sy + 2];
        if (!forced(d) && boxes.some(o => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1])) continue;
        boxes.push(b); keep.push(d);
      }
    }
    const on = new Set(keep.map(d => d.id));
    // taille constante à l'écran, quel que soit le zoom
    nSel.classed("lab", d => on.has(d.id)).select("text")
      .attr("font-size", fs / k).attr("dy", d => radius(d) + fs * 1.05 / k)
      .style("stroke-width", 3 / k);
  }

  // ---------- surbrillance ----------
  function highlight() {
    const v = lastView; if (!v) return;
    const focus = hoverId || selectedId;
    const near = focus && v.adj.get(focus);
    const vis = focus && simNodes.has(focus) && v.ns.some(n => n.id === focus);
    nSel.classed("dim", d => !!(vis && d.id !== focus && !(near && near.has(d.id))))
        .classed("hl", d => !!(vis && (d.id === focus || (near && near.has(d.id)))))
        .classed("sel", d => d.id === selectedId);
    if (!vis && v.match.size) nSel.classed("dim", d => d.id !== ROOT && !v.match.has(d.id));
    eSel.classed("dim", d => vis ? (d.source.id !== focus && d.target.id !== focus) : v.match.size > 0)
        .classed("hl", d => !!vis && (d.source.id === focus || d.target.id === focus));
    scheduleLabels();
  }

  function tip(ev, d) {
    const t = $("tip");
    if (d.id === ROOT) { t.innerHTML = "<b>Racine de l'espace Notion</b>"; }
    else {
      const v = lastView, men = (D.mOut.get(d.id)?.size || 0) + (D.mIn.get(d.id)?.size || 0);
      t.innerHTML = `<b>${esc(labelText(d))}</b><span>${esc(pathOf(d.id).join(" / ") || "Racine")} · ${d.desc || 0} sous-pages · ${men} mentions</span>`;
    }
    t.style.display = "block";
    const x = Math.min(ev.clientX + 14, innerWidth - t.offsetWidth - 8), y = Math.min(ev.clientY + 14, innerHeight - t.offsetHeight - 8);
    t.style.left = x + "px"; t.style.top = y + "px";
  }
  function pathOf(id) {
    const out = []; let p = nodes.get(id)?.parent, g = 0;
    while (p && p !== ROOT && g++ < 60) { const n = nodes.get(p); if (!n) break; out.unshift(n.title); p = n.parent; }
    return out;
  }

  // ---------- caméra ----------
  function fit(duration = 600) {
    const v = lastView; if (!v) return;
    const pts = v.ns.map(n => simNodes.get(n.id)).filter(Boolean);
    if (!pts.length) return;
    const [x0, x1] = d3.extent(pts, d => d.x), [y0, y1] = d3.extent(pts, d => d.y);
    const pad = 70, W = innerWidth, H = innerHeight;
    const k = Math.min(4, 0.95 / Math.max((x1 - x0 + pad * 2) / W, (y1 - y0 + pad * 2) / H));
    const t = d3.zoomIdentity.translate(W / 2 - k * (x0 + x1) / 2, H / 2 - k * (y0 + y1) / 2).scale(k);
    svg.transition().duration(duration).call(zoom.transform, t);
  }
  function focusNode(id, { open = true } = {}) {
    if (!lastView.ns.some(n => n.id === id)) { // caché par un filtre : on l'affiche quand même via la sélection
      selectedId = id; refresh();
    }
    const d = simNodes.get(id); if (!d) return;
    const k = Math.max(T.k, 1.4);
    svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity.translate(innerWidth / 2 - d.x * k, innerHeight / 2 - d.y * k).scale(k));
    if (open) select(id);
  }

  // =====================================================================
  //  Panneau « page sélectionnée »
  // =====================================================================
  function select(id) {
    const prev = selectedId; selectedId = id;
    if (!id) { $("info").classList.remove("open"); if (S.local && prev) refresh(); else highlight(); return; }
    $("settings").classList.toggle("open", $("settings").classList.contains("open") && innerWidth > 700);
    if (S.local) refresh(); else highlight();
    restyleSel(); renderInfo();
  }
  const restyleSel = () => nSel.classed("sel", d => d.id === selectedId);
  function renderInfo() {
    const n = nodes.get(selectedId), box = $("info");
    if (!n) { box.classList.remove("open"); return; }
    const crumbs = []; let p = n.parent, g = 0;
    while (p && p !== ROOT && g++ < 60) { const x = nodes.get(p); if (!x) break; crumbs.unshift(x); p = x.parent; }
    const kids = (D.children.get(n.id) || []).map(x => nodes.get(x));
    const out = [...(D.mOut.get(n.id) || [])].map(x => nodes.get(x)), inn = [...(D.mIn.get(n.id) || [])].map(x => nodes.get(x));
    const typeLbl = { database: "Base de données", row: "Ligne de base", page: "Page" }[n.type];
    const edited = Date.parse(n.edited);
    const li = (x, dir) => `<li data-id="${x.id}"><span class="dot" style="background:${colorOf(x) === "none" ? "transparent" : colorOf(x)}"></span>${esc(labelText(x))}${dir ? `<span class="dir">${dir}</span>` : ""}</li>`;
    const branchHidden = n.branch !== TRUNK && S.hiddenBranches.includes(n.branch);
    box.innerHTML = `
      <header><h2>${typeLbl}</h2><button class="iconbtn" data-close="info" title="Fermer (Échap)"><svg class="ico"><use href="#i-x"/></svg></button></header>
      <div class="body">
        <div class="crumbs">${crumbs.length ? crumbs.map(c => `<a data-id="${c.id}">${esc(c.title)}</a>`).join("<span>/</span>") : "<span>Racine</span>"}</div>
        <div class="ttl">${esc(labelText(n))}</div>
        <div class="stats">
          <div class="stat"><b>${kids.length}</b><span>enfants</span></div>
          <div class="stat"><b>${n.desc || 0}</b><span>descendants</span></div>
          <div class="stat"><b>${out.length + inn.length}</b><span>mentions</span></div>
        </div>
        <div class="meta">Profondeur ${n.depth}${Number.isFinite(edited) ? ` · modifiée ${ago(edited)}` : ""}</div>
        <div class="actions">
          <a class="btn" href="${esc(n.url || "https://www.notion.so/" + n.id)}" target="_blank" rel="noopener"><svg class="ico"><use href="#i-ext"/></svg>Ouvrir</a>
          <button class="btn ${S.local ? "on" : ""}" id="aLocal"><svg class="ico"><use href="#i-target"/></svg>Graphe local</button>
          ${n.branch !== TRUNK ? `<button class="btn" id="aHide"><svg class="ico"><use href="#i-eyeoff"/></svg>${branchHidden ? "Afficher" : "Masquer"} la branche</button>` : ""}
        </div>
        ${kids.length ? `<h3>Sous-pages · ${kids.length}</h3><ul>${kids.sort((a, b) => (b.desc || 0) - (a.desc || 0)).map(x => li(x)).join("")}</ul>` : ""}
        ${out.length ? `<h3>Mentionne · ${out.length}</h3><ul>${out.map(x => li(x, "→")).join("")}</ul>` : ""}
        ${inn.length ? `<h3>Mentionnée par · ${inn.length}</h3><ul>${inn.map(x => li(x, "←")).join("")}</ul>` : ""}
      </div>`;
    box.querySelectorAll("[data-id]").forEach(el => el.onclick = () => focusNode(el.dataset.id));
    $("aLocal").onclick = () => { set("local", !S.local); renderInfo(); if (S.local) setTimeout(() => fit(), 350); };
    const h = $("aHide"); if (h) h.onclick = () => toggleBranch(n.branch);
    box.classList.add("open");
  }

  // =====================================================================
  //  Légende & liste des branches
  // =====================================================================
  function toggleBranch(id) {
    const s = new Set(S.hiddenBranches);
    s.has(id) ? s.delete(id) : s.add(id);
    set("hiddenBranches", [...s]);
    toast(s.has(id) ? `Branche « ${nodes.get(id)?.title} » masquée` : `Branche « ${nodes.get(id)?.title} » affichée`);
    if (selectedId) renderInfo();
  }
  function renderLegend() {
    const L = $("legend"), hidden = new Set(S.hiddenBranches);
    let body = "";
    if (S.colorBy === "branch") {
      const top = D.branches.filter(b => D.branchColor.has(b.id)).sort((a, b) => a.title.localeCompare(b.title));
      const rest = D.branches.filter(b => !D.branchColor.has(b.id));
      body = top.map(b => `<div class="lrow ${hidden.has(b.id) ? "off" : ""}" data-b="${b.id}" title="Cliquer pour masquer/afficher"><span class="dot" style="background:${D.branchColor.get(b.id)}"></span>${esc(b.title)}<span class="n">${b.count}</span></div>`).join("")
        + (rest.length ? `<div class="lrow" style="cursor:default"><span class="dot" style="background:${OTHER}"></span>Autres<span class="n">${rest.length} br.</span></div>` : "");
    } else if (S.colorBy === "depth" || S.colorBy === "recency") {
      const g = d3.range(0, 1.01, .1).map(t => seq(t)).join(",");
      body = `<div style="color:var(--ink2)">${S.colorBy === "depth" ? "Profondeur" : "Dernière modification"}</div>
        <div class="grad" style="background:linear-gradient(90deg,${g})"></div>
        <div class="ends"><span>${S.colorBy === "depth" ? `niveau ${D.maxDepth}` : ago(D.oldest)}</span><span>${S.colorBy === "depth" ? "niveau 1" : ago(D.newest)}</span></div>`;
    } else if (S.colorBy === "type") {
      body = [["page", "Pages"], ["database", "Bases de données"], ["row", "Lignes de bases"]]
        .map(([t, l]) => `<div class="lrow" style="cursor:default"><span class="dot" style="background:${TYPE_COL[t]}"></span>${l}</div>`).join("");
    }
    L.innerHTML = `<div class="body">${body}</div>
      <div class="key" title="Réduire / déplier"><span>○ racine</span><span>— hiérarchie</span><span style="color:var(--edge-link)">┄ mention</span></div>`;
    L.querySelectorAll("[data-b]").forEach(r => {
      r.onclick = () => toggleBranch(r.dataset.b);
      r.onmouseenter = () => { nSel.classed("dim", d => d.id !== ROOT && d.branch !== r.dataset.b); eSel.classed("dim", true); };
      r.onmouseleave = () => highlight();
    });
    L.querySelector(".key").onclick = () => L.classList.toggle("min");
  }
  function renderBranchList() {
    const hidden = new Set(S.hiddenBranches);
    $("branchList").innerHTML = D.branches.map(b => `<label class="chip ${hidden.has(b.id) ? "off" : ""}">
      <input type="checkbox" data-b="${b.id}" ${hidden.has(b.id) ? "" : "checked"}>
      <span class="dot" style="background:${D.branchColor.get(b.id) || OTHER}"></span>${esc(b.title)}<span class="n">${b.count}</span></label>`).join("")
      || `<div class="hint" style="margin:0">Aucune branche</div>`;
    $("branchList").querySelectorAll("input[data-b]").forEach(i => i.onchange = () => toggleBranch(i.dataset.b));
  }
  function updateBadge() {
    let n = 0;
    if (S.maxDepth) n++; if (S.recency) n++; if (!S.typePage || !S.typeDb || S.typeRow) n++;
    if (S.linkedOnly) n++; if (S.hiddenBranches.length) n++; if (S.local) n++;
    if (S.searchMode === "filter" && query.trim()) n++;
    const b = $("fBadge"); b.textContent = n; b.classList.toggle("show", n > 0);
  }

  // =====================================================================
  //  Liaison des contrôles
  // =====================================================================
  function fmt(k, v) {
    if (k === "maxDepth") return v ? String(v) : "∞";
    if (k === "gravity") return (+v).toFixed(3);
    if (k === "nodeScale" || k === "edgeWidth") return (+v).toFixed(1) + "×";
    if (k === "fontSize") return v + " px";
    if (k === "localDepth") return v + (v > 1 ? " sauts" : " saut");
    return String(v);
  }
  function syncControls() {
    document.querySelectorAll("[data-k]").forEach(el => {
      const k = el.dataset.k, v = S[k];
      if (el.classList.contains("seg")) el.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.v === v));
      else if (el.type === "checkbox") el.checked = !!v;
      else el.value = String(v);
    });
    document.querySelectorAll("[data-o]").forEach(o => o.textContent = fmt(o.dataset.o, S[o.dataset.o]));
  }
  function set(k, v) {
    S[k] = v; saveSettings(); syncControls();
    if (STRUCT.has(k)) refresh();
    else if (STYLE.has(k)) { restyle(); renderLegend(); renderBranchList(); if (selectedId) renderInfo(); }
    else if (FORCES.has(k)) { applyForces(); if (!frozen) sim.alpha(.3).restart(); }
    else if (LABELS.has(k)) scheduleLabels();
    updateBadge();
  }
  document.querySelectorAll("[data-k]").forEach(el => {
    const k = el.dataset.k;
    if (el.classList.contains("seg")) el.querySelectorAll("button").forEach(b => b.onclick = () => set(k, b.dataset.v));
    else if (el.type === "checkbox") el.onchange = () => set(k, el.checked);
    else if (el.type === "range") el.oninput = () => set(k, +el.value);
    else el.onchange = () => set(k, isNaN(+el.value) ? el.value : +el.value);
  });
  $("brAll").onclick = () => set("hiddenBranches", []);
  $("brNone").onclick = () => set("hiddenBranches", D.branches.map(b => b.id));
  const resetFilters = () => { for (const k of ["searchMode","maxDepth","recency","typePage","typeDb","typeRow","linkedOnly","keepPath","hiddenBranches","local"]) S[k] = DEFAULTS[k]; saveSettings(); syncControls(); refresh(); };
  $("emptyReset").onclick = resetFilters;
  $("resetSettings").onclick = () => { S = { ...DEFAULTS }; saveSettings(); syncControls(); applyForces(); refresh({ reheat: .6 }); toast("Réglages réinitialisés"); };
  $("bFit2").onclick = () => fit();

  // ---------- barre ----------
  const togglePanel = (id, force) => { const p = $(id); const open = force ?? !p.classList.contains("open"); p.classList.toggle("open", open);
    if (id === "settings") { $("bSettings").classList.toggle("on", open); if (open && innerWidth <= 700) $("info").classList.remove("open"); } };
  $("bSettings").onclick = () => togglePanel("settings");
  $("bRefresh").onclick = () => sync();
  $("bFit").onclick = () => fit();
  $("bZin").onclick = () => svg.transition().duration(250).call(zoom.scaleBy, 1.4);
  $("bZout").onclick = () => svg.transition().duration(250).call(zoom.scaleBy, 1 / 1.4);
  const setFrozen = f => {
    frozen = f; $("bFreeze").classList.toggle("on", f);
    $("bFreeze").innerHTML = `<svg class="ico"><use href="#i-${f ? "play" : "pause"}"/></svg>`;
    $("bFreeze").title = f ? "Relancer la simulation (Espace)" : "Figer la disposition (Espace)";
    if (f) sim.stop(); else { simNodes.forEach(d => { d.fx = null; d.fy = null; }); sim.alpha(.3).restart(); }
  };
  $("bFreeze").onclick = () => setFrozen(!frozen);
  document.addEventListener("click", e => { const c = e.target.closest("[data-close]"); if (!c) return;
    if (c.dataset.close === "info") select(null); else togglePanel(c.dataset.close, false); });
  $("changeKey").onclick = () => askKey();
  $("fullResync").onclick = () => sync({ full: true });

  // ---------- recherche ----------
  let results = [], active = 0;
  function renderResults() {
    const q = query.trim().toLowerCase(), box = $("results");
    $("qClear").style.display = q ? "block" : "none";
    if (!q) { box.style.display = "none"; return; }
    results = [...nodes.values()].filter(n => n.id !== ROOT && n.title.toLowerCase().includes(q))
      .map(n => ({ n, s: (n.title.toLowerCase().startsWith(q) ? 100 : 0) + (n.desc || 0) + ((D.mIn.get(n.id)?.size || 0) * 2) }))
      .sort((a, b) => b.s - a.s).slice(0, 8).map(x => x.n);
    active = Math.min(active, Math.max(results.length - 1, 0));
    box.innerHTML = results.length ? results.map((n, i) => `<div class="r ${i === active ? "act" : ""}" data-i="${i}">
        <span class="dot" style="background:${colorOf(n)}"></span><span class="t">${esc(labelText(n))}</span><span class="p">${esc(pathOf(n.id).slice(-2).join(" / "))}</span></div>`).join("")
      : `<div class="empty">Aucune page trouvée</div>`;
    box.querySelectorAll(".r").forEach(r => { r.onmousedown = e => { e.preventDefault(); pick(+r.dataset.i); }; });
    box.style.display = "block";
  }
  function pick(i) { const n = results[i]; if (!n) return; $("results").style.display = "none"; $("q").blur(); focusNode(n.id); }
  let qTimer = 0;
  $("q").addEventListener("input", e => {
    query = e.target.value; active = 0; renderResults();
    clearTimeout(qTimer); qTimer = setTimeout(() => { if (S.searchMode === "filter") refresh(); else { lastView = computeView(); restyle(); } updateBadge(); }, 120);
  });
  $("q").addEventListener("keydown", e => {
    if (e.key === "ArrowDown") { active = Math.min(active + 1, results.length - 1); renderResults(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { active = Math.max(active - 1, 0); renderResults(); e.preventDefault(); }
    else if (e.key === "Enter") { pick(active); e.preventDefault(); }
    else if (e.key === "Escape") { clearSearch(); $("q").blur(); }
  });
  $("q").addEventListener("focus", renderResults);
  $("q").addEventListener("blur", () => setTimeout(() => $("results").style.display = "none", 120));
  const clearSearch = () => { $("q").value = ""; query = ""; renderResults(); refresh({ reheat: 0 }); };
  $("qClear").onclick = clearSearch;

  // ---------- clavier ----------
  document.addEventListener("keydown", e => {
    if (e.target.closest("input,select,textarea") || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (k === "/") { e.preventDefault(); $("q").focus(); }
    else if (k === "Escape") { if (selectedId) select(null); else if ($("settings").classList.contains("open")) togglePanel("settings", false); else if (query) clearSearch(); }
    else if (k === "f" || k === "F") fit();
    else if (k === "g" || k === "G") togglePanel("settings");
    else if (k === "r" || k === "R") sync();
    else if (k === "l" || k === "L") { const order = ["none", "auto", "all"]; set("labels", order[(order.indexOf(S.labels) + 1) % 3]); toast(`Titres : ${{ none: "aucun", auto: "importants", all: "tous" }[S.labels]}`); }
    else if (k === " ") { e.preventDefault(); setFrozen(!frozen); }
    else if (k === "+" || k === "=") $("bZin").click();
    else if (k === "-" || k === "_") $("bZout").click();
  });

  let toastT = 0;
  function toast(msg) { const t = $("toast"); t.textContent = msg; t.style.display = "block"; clearTimeout(toastT); toastT = setTimeout(() => t.style.display = "none", 1800); }

  // ---------- données → vue ----------
  let firstFit = true;
  function onData() {
    derive(); refresh();
    if (firstFit && nodes.size > 1) { firstFit = false; pendingFit = true; setTimeout(() => { if (pendingFit) { pendingFit = false; fit(700); } }, 3000); }
  }

  // =====================================================================
  //  Clé d'accès
  // =====================================================================
  function askKey(err) {
    $("gate").style.display = "flex"; $("keyErr").textContent = err || ""; $("keyIn").value = ""; setTimeout(() => $("keyIn").focus(), 50);
  }
  $("keyOk").onclick = () => {
    const v = $("keyIn").value.trim(); if (!v) return;
    key = v; try { localStorage.setItem(KEY_STORE, v); } catch (e) {}
    $("gate").style.display = "none"; sync();
  };
  $("keyIn").addEventListener("keydown", e => { if (e.key === "Enter") $("keyOk").click(); });
  addEventListener("resize", () => { applyForces(); if (!frozen) sim.alpha(.15).restart(); scheduleLabels(); });

  // =====================================================================
  //  Démarrage
  // =====================================================================
  syncControls();
  if (innerWidth <= 700) $("legend").classList.add("min");
  if (load()) { onData(); setStatus(summary() + " · actualisation…", "busy"); }
  else { nodes = new Map([[ROOT, { id: ROOT, title: "", type: "root", parent: null, branch: ROOT }]]); onData(); }
  if (!key) askKey(); else sync();
  setInterval(() => { if (document.visibilityState === "visible") sync(); }, AUTO_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && (!lastUpdated || Date.now() - lastUpdated > 60 * 1000)) sync();
  });
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
})();
