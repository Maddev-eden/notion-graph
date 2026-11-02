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
  const statusEl = $("status");
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const idOf = s => { const m = String(s || "").replace(/-/g, "").match(/([0-9a-f]{32})(?![0-9a-f])/i); return m ? m[1].toLowerCase() : null; };
  const setStatus = (t, err) => { statusEl.textContent = t; statusEl.className = err ? "err" : ""; };
  const ago = ts => { if (!ts) return "jamais"; const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return "à l'instant"; if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
    if (s < 86400) return `il y a ${Math.round(s / 3600)} h`; return new Date(ts).toLocaleString("fr-FR"); };

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
    syncing = true; $("refresh").disabled = true;
    let failed = 0;
    try {
      // 1) Hiérarchie : la recherche renvoie chaque page avec son parent (100 par appel)
      setStatus("Liste des pages…");
      const items = []; let cursor;
      do {
        const res = await api("/api/search", { method: "POST", body: JSON.stringify(cursor ? { start_cursor: cursor } : {}) });
        items.push(...(res.results || []));
        cursor = res.has_more ? res.next_cursor : null;
        setStatus(`Liste des pages… ${items.length}`);
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
      nodes = nN; render();

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
          setStatus(`Mentions ${done}/${done + todo.length}…`);
          if (done % 25 === 0) { render(); save(); }
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));

      lastUpdated = Date.now(); save(); render();
      setStatus(summary() + (failed ? ` · ${failed} illisibles` : ""));
    } catch (e) {
      if (e instanceof AuthError) { askKey("Clé refusée par le serveur."); setStatus("Clé invalide", true); }
      else if (e.message === "notion_unauthorized") setStatus("Token Notion refusé (voir README)", true);
      else if (e.message === "offline") setStatus(`Hors ligne · version du ${ago(lastUpdated)}`, true);
      else setStatus(`Erreur (${e.message}) · version du ${ago(lastUpdated)}`, true);
    } finally {
      syncing = false; $("refresh").disabled = false;
    }
  }
  const summary = () => {
    const pages = [...nodes.values()].filter(n => n.id !== ROOT && n.type !== "row").length;
    return `${pages} pages · màj ${ago(lastUpdated)}`;
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

  // ---------------- rendu ----------------
  const svg = d3.select("#g");
  const world = svg.append("g");
  const gEdges = world.append("g"), gNodes = world.append("g");
  let simNodes = new Map(), sim, transformK = 1, hoverId = null, selectedId = null, degree = new Map(), branchColor = new Map();
  const zoom = d3.zoom().scaleExtent([0.08, 6]).on("zoom", ev => { world.attr("transform", ev.transform); transformK = ev.transform.k; updateLabels(); });
  svg.call(zoom).on("dblclick.zoom", null);
  svg.on("click", ev => { if (ev.target === svg.node()) { selectedId = null; $("panel").style.display = "none"; applyHighlight(); } });

  function visibleGraph() {
    const showRows = $("tRows").checked, showTree = $("tTree").checked, showLink = $("tLink").checked;
    const ns = [...nodes.values()].filter(n => showRows || n.type !== "row");
    const ok = new Set(ns.map(n => n.id));
    const es = [];
    if (showTree) for (const n of ns) if (n.id !== ROOT && ok.has(n.parent)) es.push({ source: n.parent, target: n.id, kind: "tree" });
    if (showLink) {
      const seen = new Set();
      for (const [a, m] of Object.entries(mentions)) for (const b of m.ids) {
        if (!ok.has(a) || !ok.has(b) || a === b) continue;
        if (nodes.get(b).parent === a || nodes.get(a).parent === b) continue;
        const k = [a, b].sort().join("|"); if (seen.has(k)) continue; seen.add(k);
        es.push({ source: a, target: b, kind: "link" });
      }
    }
    return { ns, es };
  }

  function render() {
    const W = innerWidth, H = innerHeight;
    const { ns: raw, es } = visibleGraph();
    const ns = raw.map(n => Object.assign(simNodes.get(n.id) || { x: W / 2 + (Math.random() - .5) * 60, y: H / 2 + (Math.random() - .5) * 60 }, n));
    simNodes = new Map(ns.map(n => [n.id, n]));
    degree = new Map(); for (const e of es) { degree.set(e.source, (degree.get(e.source) || 0) + 1); degree.set(e.target, (degree.get(e.target) || 0) + 1); }
    computeColors(ns);

    const eSel = gEdges.selectAll("line").data(es, d => d.kind + (d.source.id || d.source) + "|" + (d.target.id || d.target))
      .join("line").attr("class", d => "edge " + d.kind);
    const nSel = gNodes.selectAll("g.node").data(ns, d => d.id).join(enter => {
        const g = enter.append("g").attr("class", "node");
        g.append("circle"); g.append("text").attr("dy", "1.6em").attr("text-anchor", "middle");
        return g;
      })
      .attr("class", d => "node " + d.type)
      .call(d3.drag()
        .on("start", (ev, d) => { if (!ev.active) sim.alphaTarget(.2).restart(); d.fx = d.x; d.fy = d.y; })
        .on("drag", (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
        .on("end", (ev, d) => { if (!ev.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }))
      .on("mouseenter", (ev, d) => { if (ev.pointerType === "touch") return; hoverId = d.id; applyHighlight(); tip(ev, d); })
      .on("mousemove", (ev, d) => tip(ev, d))
      .on("mouseleave", () => { hoverId = null; applyHighlight(); $("tip").style.display = "none"; })
      .on("click", (ev, d) => { ev.stopPropagation(); if (d.id !== ROOT) select(d.id); });
    nSel.select("circle").attr("r", radius).attr("fill", colorOf);
    nSel.select("text").text(d => d.id === ROOT ? "" : (d.icon ? d.icon + " " : "") + d.title);

    if (sim) sim.stop();
    sim = d3.forceSimulation(ns)
      .force("link", d3.forceLink(es).id(d => d.id).distance(d => d.kind === "tree" ? 40 : 90).strength(d => d.kind === "tree" ? .7 : .12))
      .force("charge", d3.forceManyBody().strength(d => d.id === ROOT ? -260 : -90).distanceMax(500))
      .force("collide", d3.forceCollide(d => radius(d) + 3))
      .force("x", d3.forceX(W / 2).strength(.03)).force("y", d3.forceY(H / 2).strength(.03))
      .alpha(lastUpdated ? .5 : 1)
      .on("tick", () => {
        eSel.attr("x1", d => d.source.x).attr("y1", d => d.source.y).attr("x2", d => d.target.x).attr("y2", d => d.target.y);
        nSel.attr("transform", d => `translate(${d.x},${d.y})`);
      });
    applyHighlight();
  }
  const radius = d => d.id === ROOT ? 7 : 3 + Math.sqrt(degree.get(d.id) || 1) * 1.6;
  const colorOf = n => n.id === ROOT ? "none" : (!$("tColor").checked || n.branch === TRUNK) ? "var(--node)" : (branchColor.get(n.branch) || OTHER);

  function computeColors(ns) {
    const counts = d3.rollup(ns.filter(n => n.id !== ROOT && n.branch !== TRUNK), v => v.length, n => n.branch);
    // la couleur suit la branche, pas son rang : 7 plus grosses branches, triées par titre, le reste en « Autres »
    const big = [...counts].sort((a, b) => b[1] - a[1]).slice(0, PALETTE.length).map(d => d[0])
      .sort((a, b) => (nodes.get(a)?.title || "").localeCompare(nodes.get(b)?.title || ""));
    branchColor = new Map(big.map((b, i) => [b, PALETTE[i]]));
    const rows = $("tColor").checked ? big.map(b => `<div class="row" data-id="${b}"><span class="sw" style="background:${branchColor.get(b)}"></span>${esc(nodes.get(b)?.title)} <span style="color:var(--muted)">(${counts.get(b)})</span></div>`) : [];
    const rest = [...counts.keys()].filter(b => !branchColor.has(b));
    if ($("tColor").checked && rest.length) rows.push(`<div class="row"><span class="sw" style="background:${OTHER}"></span>Autres (${rest.length} branches)</div>`);
    const leg = $("legend");
    leg.innerHTML = rows.join("") + `<div class="key">○ racine · — hiérarchie · ┄ mention</div>`;
    leg.querySelectorAll(".row[data-id]").forEach(r => r.onclick = () => focusNode(r.dataset.id));
    leg.querySelector(".key").onclick = () => leg.classList.toggle("min");
  }

  function neighbors(id) {
    const s = new Set([id]);
    gEdges.selectAll("line").each(d => { if (d.source.id === id) s.add(d.target.id); if (d.target.id === id) s.add(d.source.id); });
    return s;
  }
  function applyHighlight() {
    const q = $("q").value.trim().toLowerCase();
    const focus = hoverId || selectedId;
    const nb = focus ? neighbors(focus) : null;
    gNodes.selectAll("g.node")
      .classed("dim", d => (nb && !nb.has(d.id)) || (!!q && d.id !== ROOT && !d.title.toLowerCase().includes(q)))
      .classed("hl", d => d.id === focus);
    gEdges.selectAll("line")
      .classed("dim", d => (nb && d.source.id !== focus && d.target.id !== focus) || !!q)
      .classed("hl", d => !!focus && (d.source.id === focus || d.target.id === focus));
    updateLabels(nb, q);
  }
  function updateLabels(nb, q) {
    const all = $("tLabels").checked, focus = hoverId || selectedId;
    q = q ?? $("q").value.trim().toLowerCase();
    nb = nb ?? (focus ? neighbors(focus) : null);
    gNodes.selectAll("g.node text").style("display", d => {
      if (d.id === ROOT) return "none";
      if (nb) return nb.has(d.id) ? null : "none";
      if (q) return d.title.toLowerCase().includes(q) ? null : "none";
      if (all) return null;
      return transformK > 1.4 || d.parent === ROOT || d.id === d.branch || (degree.get(d.id) || 0) >= 6 ? null : "none";
    });
  }
  function tip(ev, d) {
    const t = $("tip");
    t.textContent = d.id === ROOT ? "Racine de l'espace Notion" : (d.icon ? d.icon + " " : "") + d.title;
    t.style.display = "block"; t.style.left = (ev.clientX + 12) + "px"; t.style.top = (ev.clientY + 12) + "px";
  }
  function select(id) {
    selectedId = id; applyHighlight();
    const n = nodes.get(id), p = $("panel");
    $("settings").style.display = "none";
    const path = []; let cur = n, g = 0;
    while (cur && cur.parent && cur.parent !== ROOT && g++ < 40) { cur = nodes.get(cur.parent); if (cur) path.unshift(cur.title); }
    const kids = [...nodes.values()].filter(x => x.parent === id && ($("tRows").checked || x.type !== "row"));
    const linkIds = new Set();
    for (const [a, m] of Object.entries(mentions)) for (const b of m.ids) { if (a === id && nodes.has(b)) linkIds.add(b); if (b === id && nodes.has(a)) linkIds.add(a); }
    const links = [...linkIds].map(x => nodes.get(x));
    const typeLbl = { database: "base de données", row: "ligne de base" }[n.type];
    p.innerHTML = `<button class="close" data-close="panel">✕</button>
      <h3>${esc((n.icon ? n.icon + " " : "") + n.title)}</h3>
      <div class="meta">${esc(path.join(" / ") || "Racine")}${typeLbl ? " · " + typeLbl : ""}</div>
      <a href="${esc(n.url || "https://www.notion.so/" + id)}" target="_blank" rel="noopener">Ouvrir dans Notion ↗</a>
      ${kids.length ? `<div class="meta">Sous-pages (${kids.length})</div><ul>${kids.map(k => `<li data-id="${k.id}">${esc(k.title)}</li>`).join("")}</ul>` : ""}
      ${links.length ? `<div class="meta">Mentions (${links.length})</div><ul>${links.map(k => `<li data-id="${k.id}">${esc(k.title)}</li>`).join("")}</ul>` : ""}`;
    p.querySelectorAll("li[data-id]").forEach(li => li.onclick = () => focusNode(li.dataset.id));
    p.style.display = "block";
  }
  function focusNode(id) {
    const d = simNodes.get(id); if (!d) return;
    const k = Math.max(transformK, 1.6);
    svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity.translate(innerWidth / 2 - d.x * k, innerHeight / 2 - d.y * k).scale(k));
    select(id);
  }

  // ---------------- clé d'accès ----------------
  function askKey(err) {
    $("gate").style.display = "flex"; $("keyErr").textContent = err || ""; $("keyIn").value = ""; $("keyIn").focus();
  }
  $("keyOk").onclick = () => {
    const v = $("keyIn").value.trim(); if (!v) return;
    key = v; try { localStorage.setItem(KEY_STORE, v); } catch (e) {}
    $("gate").style.display = "none"; sync();
  };
  $("keyIn").addEventListener("keydown", e => { if (e.key === "Enter") $("keyOk").click(); });

  // ---------------- contrôles ----------------
  $("q").addEventListener("input", applyHighlight);
  $("q").addEventListener("keydown", ev => {
    if (ev.key !== "Enter") return;
    const q = ev.target.value.trim().toLowerCase();
    const hit = [...simNodes.values()].find(n => n.id !== ROOT && n.title.toLowerCase().includes(q));
    if (hit) { ev.target.blur(); focusNode(hit.id); }
  });
  ["tTree", "tLink", "tRows"].forEach(id => $(id).addEventListener("change", render));
  $("tColor").addEventListener("change", () => { computeColors([...simNodes.values()]); gNodes.selectAll("g.node circle").attr("fill", colorOf); });
  $("tLabels").addEventListener("change", () => updateLabels());
  $("refresh").onclick = () => sync();
  $("gear").onclick = () => {
    const s = $("settings"); const open = s.style.display === "block";
    s.style.display = open ? "none" : "block"; $("panel").style.display = "none";
    $("info").textContent = `${summary()} · ${Object.keys(mentions).length} pages analysées`;
  };
  $("changeKey").onclick = () => { $("settings").style.display = "none"; askKey(); };
  $("resetCache").onclick = () => { $("settings").style.display = "none"; sync({ full: true }); };
  document.addEventListener("click", e => { const c = e.target.closest("[data-close]"); if (c) $(c.dataset.close).style.display = "none"; });
  addEventListener("resize", () => { if (sim) { sim.force("x").x(innerWidth / 2); sim.force("y").y(innerHeight / 2); sim.alpha(.2).restart(); } });

  // ---------------- démarrage ----------------
  if (load()) { render(); setStatus(summary() + " · actualisation…"); }
  else { nodes = new Map([[ROOT, { id: ROOT, title: "", type: "root", parent: null, branch: ROOT }]]); render(); }
  if (!key) askKey(); else sync();
  setInterval(() => { if (document.visibilityState === "visible") sync(); }, AUTO_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && (!lastUpdated || Date.now() - lastUpdated > 60 * 1000)) sync();
  });
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
})();
