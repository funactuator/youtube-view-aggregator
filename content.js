/* YouTube Channel View Aggregator — content script
 * - Injects a spacious, theme-aware panel above the channel's video grid
 * - Sums EXACT views across the first N videos (respecting Latest/Popular/Oldest)
 * - Shows Total, Average, Top & Lowest video in roomy cells
 * - Injects EXACT upload date under each video card as it scrolls into view
 */

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const PANEL_ID = "ytva-panel";
const DATE_CLASS = "ytva-date";
const BAR_SVG = '<svg viewBox="0 0 24 24" width="17" height="17"><rect x="3" y="12" width="4" height="9" rx="1" fill="currentColor"/><rect x="10" y="7" width="4" height="14" rx="1" fill="currentColor"/><rect x="17" y="3" width="4" height="18" rx="1" fill="currentColor"/></svg>';
const UP_SVG = '<svg class="ytva-ar ytva-up" viewBox="0 0 10 10" width="9" height="9"><path d="M5 1 L9 8 L1 8 Z" fill="currentColor"/></svg>';
const DN_SVG = '<svg class="ytva-ar ytva-dn" viewBox="0 0 10 10" width="9" height="9"><path d="M5 9 L9 2 L1 2 Z" fill="currentColor"/></svg>';

// YouTube enforces Trusted Types; route the one innerHTML through a policy.
const TT = (() => {
  try {
    if (window.trustedTypes && trustedTypes.createPolicy) {
      const p = trustedTypes.createPolicy("ytva", { createHTML: (s) => s });
      return (s) => p.createHTML(s);
    }
  } catch {}
  return (s) => s;
})();

/* ---------- number formatting ---------- */
function fmtExact(n) { return n.toLocaleString("en-US"); }
function trim(s) { return s.replace(/\.?0+$/, ""); }
function abbrevIntl(n) {
  if (n >= 1e9) return trim((n / 1e9).toFixed(n >= 1e10 ? 0 : 1)) + "B";
  if (n >= 1e6) return trim((n / 1e6).toFixed(n >= 1e7 ? 0 : 1)) + "M";
  if (n >= 1e3) return trim((n / 1e3).toFixed(n >= 1e4 ? 0 : 1)) + "K";
  return String(n);
}
function abbrevIndian(n) {
  if (n >= 1e7) return trim((n / 1e7).toFixed(2)) + " Cr";
  if (n >= 1e5) return trim((n / 1e5).toFixed(2)) + " L";
  return null;
}
function abbrevSub(n) {
  const ind = abbrevIndian(n);
  return ind ? `${abbrevIntl(n)} · ${ind}` : abbrevIntl(n);
}
// 2-decimal rounded figures (the prominent display) — International + Indian.
function abIntl2(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return String(n);
}
function abInd2(n) {
  if (n >= 1e7) return (n / 1e7).toFixed(2) + " Cr";
  if (n >= 1e5) return (n / 1e5).toFixed(2) + " L";
  return null; // below 1 lakh there is no lakh/crore — skip the Indian line
}
function roundedViews(n) {
  const ind = abInd2(n);
  return ind ? `${abIntl2(n)} · ${ind}` : abIntl2(n);
}
function fmtDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  if (!m) return iso || "—";
  return `${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}`;
}

/* ---------- DOM scraping ---------- */
function getCards() {
  let cards = [...document.querySelectorAll("ytd-rich-item-renderer, ytd-grid-video-renderer")]
    .filter((c) => c.querySelector('a[href*="/watch?v="]'));
  if (!cards.length) {
    cards = [...document.querySelectorAll(".ytLockupViewModelHost")]
      .filter((c) => c.querySelector('a[href*="/watch?v="]'));
  }
  return cards;
}
function getVideoId(card) {
  const a = card.querySelector('a[href*="/watch?v="]');
  if (a) {
    try { return new URL(a.href, location.origin).searchParams.get("v"); } catch {}
  }
  const host = /content-id-/.test(card.className) ? card : card.querySelector('[class*="content-id-"]');
  if (host) {
    const m = /content-id-([\w-]{11})/.exec(host.className);
    if (m) return m[1];
  }
  return null;
}
function getTitle(card) {
  const t = card.querySelector(".ytLockupMetadataViewModelTitle, #video-title, #video-title-link");
  return t ? t.textContent.trim() : "(untitled)";
}
function getGrid() {
  return document.querySelector("ytd-rich-grid-renderer");
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function ensureCards(need) {
  if (getCards().length >= need) return getCards();   // already loaded — no scroll, no jump
  const y = window.scrollY;
  let stall = 0;
  while (getCards().length < need && stall < 8) {
    const count = getCards().length;
    window.scrollTo(0, document.documentElement.scrollHeight);
    await sleep(650);
    if (getCards().length === count) stall++; else stall = 0;
  }
  window.scrollTo(0, y);                               // restore where the user was
  return getCards();
}

/* ---------- stats fetch (cached, shared by Calculate + auto-dates) ---------- */
const statCache = new Map();
async function fetchStats(id) {
  if (statCache.has(id)) return statCache.get(id);
  let result = { id, views: null, date: null };
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${id}`, { credentials: "omit" });
    const html = await res.text();
    const v = html.match(/"viewCount":"(\d+)"/);
    const d = html.match(/"publishDate":"([^"]+)"/);
    result = { id, views: v ? parseInt(v[1], 10) : null, date: d ? d[1] : null };
  } catch (e) {}
  if (result.views != null || result.date) statCache.set(id, result);
  return result;
}
async function mapPool(items, worker, concurrency, onProgress) {
  const results = new Array(items.length);
  let i = 0, done = 0;
  async function runOne() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx], idx);
      onProgress && onProgress(++done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runOne));
  return results;
}

/* ---------- date injection under each card ---------- */
function injectDate(card, stat) {
  card.querySelectorAll("." + DATE_CLASS).forEach((n) => n.remove());
  const el = document.createElement("div");
  el.className = DATE_CLASS;
  el.textContent = stat && stat.date ? "📅 " + fmtDate(stat.date) : "📅 —";
  if (!(stat && stat.date)) el.classList.add("ytva-date-missing");
  const metaLine = card.querySelector(".ytContentMetadataViewModelHost");
  if (metaLine && metaLine.parentElement) {
    metaLine.parentElement.insertBefore(el, metaLine.nextSibling);
    return;
  }
  (card.querySelector(".ytLockupMetadataViewModelHost") || card).appendChild(el);
}

/* ---------- auto dates: date each card as it scrolls into view ---------- */
const autoSeen = new WeakSet();
let autoQueue = [], autoActive = 0, autoObserver = null, autoScanTimer = null, autoMutObserver = null;
function pumpAuto() {
  while (autoActive < 3 && autoQueue.length) {
    const card = autoQueue.shift();
    if (!card.isConnected || card.querySelector("." + DATE_CLASS)) continue;
    const id = getVideoId(card);
    if (!id) continue;
    autoActive++;
    fetchStats(id).then((s) => card.isConnected && injectDate(card, s)).finally(() => { autoActive--; pumpAuto(); });
  }
}
function observeCards() {
  if (!autoObserver) return;
  getCards().forEach((c) => {
    if (!autoSeen.has(c) && !c.querySelector("." + DATE_CLASS)) autoObserver.observe(c);
  });
}
function startAutoDates() {
  if (!autoObserver) {
    autoObserver = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting && !autoSeen.has(e.target)) {
          autoSeen.add(e.target);
          autoObserver.unobserve(e.target);
          autoQueue.push(e.target);
        }
      });
      pumpAuto();
    }, { rootMargin: "500px 0px" });
    autoMutObserver = new MutationObserver(() => {
      clearTimeout(autoScanTimer);
      autoScanTimer = setTimeout(observeCards, 400);
    });
    autoMutObserver.observe(document.body, { childList: true, subtree: true });
  }
  observeCards();
}

/* ---------- sort tabs ---------- */
let selectedSort = "Latest";
function sortButtons() {
  return [...document.querySelectorAll(
    'chip-bar-view-model button[role="tab"], ytd-feed-filter-chip-bar-renderer yt-chip-cloud-chip-renderer, #chips tp-yt-paper-chip'
  )];
}
function findSortButton(name) {
  return sortButtons().find((b) => b.textContent.trim().toLowerCase() === name.toLowerCase());
}
function detectActiveSort() {
  const b = sortButtons().find((x) => x.getAttribute("aria-selected") === "true" || x.hasAttribute("selected"));
  const txt = b ? b.textContent.trim() : "Latest";
  return ["Latest", "Popular", "Oldest"].includes(txt) ? txt : "Latest";
}
async function selectSort(name) {
  const btn = findSortButton(name);
  if (!btn) return false;
  if (btn.getAttribute("aria-selected") === "true" || btn.hasAttribute("selected")) return true;
  const y = window.scrollY;
  const before = getCards()[0] ? getVideoId(getCards()[0]) : null;
  btn.click();
  for (let k = 0; k < 25; k++) {
    await sleep(280);
    const first = getCards()[0] ? getVideoId(getCards()[0]) : null;
    if (first && first !== before) break;
  }
  await sleep(300);
  window.scrollTo(0, y);                               // YouTube jumps to top on chip click — undo it
  return true;
}

/* ---------- panel ---------- */
function isChannelPage() {
  return /^\/(@|channel\/|c\/|user\/)/.test(location.pathname);
}
function isVideosPage() {
  return isChannelPage() && /\/videos\/?$/.test(location.pathname);
}
function themeClass() {
  return document.documentElement.hasAttribute("dark") ? "ytva-dark" : "ytva-light";
}
function clampN(v) { return Math.max(1, Math.min(200, parseInt(v, 10) || 10)); }

function buildPanel() {
  if (document.getElementById(PANEL_ID)) { placePanel(); return document.getElementById(PANEL_ID); }
  const p = document.createElement("div");
  p.id = PANEL_ID;
  p.className = themeClass();
  p.innerHTML = TT(`
    <div class="ytva-head">
      <div class="ytva-brand">
        <div class="ytva-logo">${BAR_SVG}</div>
        <div class="ytva-name">View Aggregator<span id="ytva-context"></span></div>
      </div>
      <div class="ytva-ctrl">
        <div class="ytva-seg" id="ytva-sort">
          <button data-sort="Latest">Latest</button>
          <button data-sort="Popular">Popular</button>
          <button data-sort="Oldest">Oldest</button>
        </div>
        <div class="ytva-nw">Top<input id="ytva-n" type="number" min="1" max="200" value="10"/>videos</div>
        <button id="ytva-calc" class="ytva-go"><span class="ytva-spinner" aria-hidden="true"></span><span class="ytva-go-label">Calculate</span></button>
        <button id="ytva-toggle" class="ytva-toggle" title="Collapse">▾</button>
      </div>
    </div>
    <div class="ytva-progress" id="ytva-progress"><div class="ytva-progress-fill" id="ytva-progress-fill"></div></div>
    <div class="ytva-grid" id="ytva-grid">
      <div class="ytva-cell">
        <span class="ytva-cload" aria-hidden="true"></span>
        <div class="ytva-clabel">Total views</div>
        <div class="ytva-cval num" id="ytva-total">—</div>
        <div class="ytva-cind num" id="ytva-total-ind"></div>
        <div class="ytva-cexact num" id="ytva-total-exact"></div>
      </div>
      <div class="ytva-cell">
        <span class="ytva-cload" aria-hidden="true"></span>
        <div class="ytva-clabel">Average / video</div>
        <div class="ytva-cval sm num" id="ytva-avg">—</div>
        <div class="ytva-cind num" id="ytva-avg-ind"></div>
        <div class="ytva-cexact num" id="ytva-avg-exact"></div>
      </div>
      <div class="ytva-cell">
        <span class="ytva-cload" aria-hidden="true"></span>
        <div class="ytva-clabel">${UP_SVG}Top video</div>
        <a class="ytva-ctitle ytva-link" id="ytva-top-title" target="_blank" rel="noopener noreferrer">—</a>
        <div class="ytva-cvr num ytva-up" id="ytva-top-r"></div>
        <div class="ytva-cexact num" id="ytva-top-exact"></div>
      </div>
      <div class="ytva-cell">
        <span class="ytva-cload" aria-hidden="true"></span>
        <div class="ytva-clabel">${DN_SVG}Lowest video</div>
        <a class="ytva-ctitle ytva-link" id="ytva-low-title" target="_blank" rel="noopener noreferrer">—</a>
        <div class="ytva-cvr num ytva-dn" id="ytva-low-r"></div>
        <div class="ytva-cexact num" id="ytva-low-exact"></div>
      </div>
    </div>`);
  placePanel(p);

  chrome.storage.sync.get({ ytvaN: 10 }, (d) => {
    const inp = p.querySelector("#ytva-n");
    if (inp) inp.value = d.ytvaN;
    idleContext();
  });

  selectedSort = detectActiveSort();
  highlightSort(selectedSort);

  p.querySelectorAll("#ytva-sort button").forEach((b) => {
    b.onclick = () => {
      if (running) return;
      selectedSort = b.dataset.sort;
      highlightSort(selectedSort);
      run(clampN(p.querySelector("#ytva-n").value), selectedSort);
    };
  });
  p.querySelector("#ytva-calc").onclick = () => {
    const n = clampN(p.querySelector("#ytva-n").value);
    p.querySelector("#ytva-n").value = n;
    chrome.storage.sync.set({ ytvaN: n });
    run(n, selectedSort);
  };
  p.querySelector("#ytva-n").addEventListener("keydown", (e) => {
    if (e.key === "Enter") p.querySelector("#ytva-calc").click();
  });
  p.querySelector("#ytva-toggle").onclick = () => toggleCollapse();
  return p;
}

function placePanel(p) {
  p = p || document.getElementById(PANEL_ID);
  if (!p) return;
  // Preferred spot: channel header, just above the tab bar (Home/Videos/…) — like vidIQ.
  const toolbar = document.querySelector("tp-yt-app-toolbar");
  const anchor = toolbar && toolbar.parentElement ? toolbar : getGrid();
  if (!anchor || !anchor.parentElement) return;
  if (p.nextElementSibling !== anchor) anchor.parentElement.insertBefore(p, anchor);
  alignPanel();
}

// Match the panel's width + left offset to the video content column (like vidIQ),
// instead of spanning the full header width. Recomputed on layout changes.
function alignPanel() {
  const p = document.getElementById(PANEL_ID);
  if (!p || !p.parentElement) return;
  const ref = document.querySelector("#primary") || getGrid() ||
              document.querySelector("tp-yt-paper-tabs#tabs");
  if (!ref) return;
  const rr = ref.getBoundingClientRect();
  if (rr.width < 100) return; // not laid out yet
  const pr = p.parentElement.getBoundingClientRect();
  p.style.width = rr.width + "px";
  p.style.marginLeft = Math.max(0, Math.round(rr.left - pr.left)) + "px";
}

function highlightSort(name) {
  const bar = document.getElementById("ytva-sort");
  if (!bar) return;
  bar.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.sort === name));
}

let collapsed = false;
function toggleCollapse() {
  collapsed = !collapsed;
  const grid = document.getElementById("ytva-grid");
  const tog = document.getElementById("ytva-toggle");
  if (grid) grid.style.display = collapsed ? "none" : "grid";
  if (tog) { tog.textContent = collapsed ? "▸" : "▾"; tog.title = collapsed ? "Expand" : "Collapse"; }
}

function setContext(msg) {
  const el = document.getElementById("ytva-context");
  if (el) el.textContent = msg;
}
function idleContext() {
  const inp = document.getElementById("ytva-n");
  const n = inp ? clampN(inp.value) : 10;
  setContext(`First ${n} videos · ${selectedSort}`);
}
function setCell(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }

function setProgress(pct) {
  const f = document.getElementById("ytva-progress-fill");
  if (f) f.style.width = Math.max(0, Math.min(100, pct)) + "%";
}
function setBusy(on) {
  const p = document.getElementById(PANEL_ID);
  if (p) p.classList.toggle("ytva-busy", on);
  const btn = document.getElementById("ytva-calc");
  if (btn) btn.disabled = on;
  const label = document.querySelector("#ytva-calc .ytva-go-label");
  if (label) label.textContent = on ? "Calculating…" : "Calculate";
  if (!on) setProgress(0);
}

function setLink(id, title, videoId) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = title || "—";
  if (videoId) {
    el.href = `https://www.youtube.com/watch?v=${videoId}`;
    el.title = title;
  } else {
    el.removeAttribute("href");
    el.removeAttribute("title");
  }
}
function setInd(id, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text || "";
  el.style.display = text ? "" : "none";
}
function renderResults(r) {
  if (!r) {
    setCell("ytva-total", "—"); setCell("ytva-avg", "—");
    setInd("ytva-total-ind", ""); setInd("ytva-avg-ind", "");
    ["ytva-total-exact", "ytva-avg-exact", "ytva-top-r", "ytva-top-exact", "ytva-low-r", "ytva-low-exact"]
      .forEach((id) => setCell(id, ""));
    setLink("ytva-top-title", "—", null);
    setLink("ytva-low-title", "—", null);
    return;
  }
  const { total, counted, avg, top, bottom } = r;
  const avgR = Math.round(avg);
  // prominent = 2-decimal rounded (M/K + Lakh/Cr); exact number kept subtle below
  setCell("ytva-total", abIntl2(total));
  setInd("ytva-total-ind", abInd2(total));
  setCell("ytva-total-exact", `${fmtExact(total)} · across ${counted} videos`);
  setCell("ytva-avg", abIntl2(avgR));
  setInd("ytva-avg-ind", abInd2(avgR));
  setCell("ytva-avg-exact", `${fmtExact(avgR)} each`);
  setLink("ytva-top-title", top.title, top.id);
  setCell("ytva-top-r", roundedViews(top.views));
  setCell("ytva-top-exact", `${fmtExact(top.views)} views`);
  setLink("ytva-low-title", bottom.title, bottom.id);
  setCell("ytva-low-r", roundedViews(bottom.views));
  setCell("ytva-low-exact", `${fmtExact(bottom.views)} views`);
}

/* ---------- main run ---------- */
let running = false;
async function run(n, sort) {
  if (running) return;
  running = true;
  setBusy(true);
  setProgress(6);
  try {
    if (sort && sort !== detectActiveSort()) {
      setContext(`Sorting by ${sort}…`);
      await selectSort(sort);
      observeCards();
    }
    setContext("Loading videos…");
    const cards = (await ensureCards(n)).slice(0, n);
    if (!cards.length) { setContext("No videos found here."); return; }
    const meta = cards.map((c) => ({ card: c, id: getVideoId(c), title: getTitle(c) }));
    setContext(`Fetching 0/${cards.length}…`);
    const stats = await mapPool(meta, (m) => fetchStats(m.id), 4,
      (done, tot) => { setContext(`Fetching ${done}/${tot}…`); setProgress((done / tot) * 100); });

    let total = 0, counted = 0, missing = 0, top = null, bottom = null;
    stats.forEach((s, i) => {
      injectDate(meta[i].card, s);
      if (s && s.views != null) {
        total += s.views; counted++;
        const entry = { id: meta[i].id, title: meta[i].title, views: s.views };
        if (!top || s.views > top.views) top = entry;
        if (!bottom || s.views < bottom.views) bottom = entry;
      } else missing++;
    });
    if (!counted) { setContext("Couldn't read views — try again."); return; }
    renderResults({ total, counted, avg: total / counted, top, bottom });
    setContext(`First ${counted} videos · ${selectedSort}${missing ? ` · ${missing} skipped` : ""}`);
  } finally {
    running = false;
    setBusy(false);
  }
}

/* ---------- lifecycle (YouTube SPA) ---------- */
let autoRan = false;
async function maybeInject() {
  if (!isVideosPage()) { document.getElementById(PANEL_ID)?.remove(); return; }
  // wait briefly for the header/grid to exist
  for (let k = 0; k < 25 && !document.querySelector("tp-yt-app-toolbar"); k++) await sleep(300);
  const p = buildPanel();
  if (p) p.className = themeClass();
  startAutoDates();
  if (!autoRan) {
    autoRan = true;
    for (let k = 0; k < 20 && getCards().length < 1; k++) await sleep(300);
    run(clampN((document.getElementById("ytva-n") || {}).value || 10), selectedSort);
  }
}
maybeInject();
window.addEventListener("yt-navigate-finish", () => { autoRan = false; setTimeout(maybeInject, 400); });
document.addEventListener("yt-page-data-updated", () => setTimeout(() => { placePanel(); observeCards(); }, 400));

let alignTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(alignTimer);
  alignTimer = setTimeout(alignPanel, 120);
});
// YouTube's collapsing header can settle a beat after load — realign a couple of times.
[600, 1200, 2000].forEach((t) => setTimeout(alignPanel, t));

// keep theme in sync with YouTube's dark/light toggle
new MutationObserver(() => {
  const p = document.getElementById(PANEL_ID);
  if (p) p.className = (collapsed ? "" : "") + themeClass();
}).observe(document.documentElement, { attributes: true, attributeFilter: ["dark"] });

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg && msg.type === "YTVA_TOGGLE") {
    if (!document.getElementById(PANEL_ID)) maybeInject();
    else toggleCollapse();
    sendResponse({ ok: true });
  }
  return true;
});
