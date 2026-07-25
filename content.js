/* YouTube Channel View Aggregator — content script
 * - Injects a theme-aware strip above the channel's video/shorts grid
 * - Sums EXACT views across the selected range (Top N / last N months / all time)
 * - Reports total, average, per-month, the monthly shape, and the extremes
 * - Injects EXACT upload date under each video card as it scrolls into view
 */

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const PANEL_ID = "ytva-panel";
const DATE_CLASS = "ytva-date";
const BAR_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="3" y="12" width="4" height="9" rx="1" fill="currentColor"/><rect x="10" y="7" width="4" height="14" rx="1" fill="currentColor"/><rect x="17" y="3" width="4" height="18" rx="1" fill="currentColor"/></svg>';
const CHEV_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M7 10l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const KIND_WORD = { videos: "video", shorts: "short", both: "item" };

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
function fmtDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  if (!m) return iso || "—";
  return `${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}`;
}
function fmtMonth(d) { return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`; }

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

// `allowScroll` is false for the run that fires by itself on page load: yanking the
// viewport to the bottom and back while the user is still reading looks like the page
// is broken. There we just wait for YouTube's own render and use whatever is there.
async function ensureCards(need, allowScroll) {
  if (getCards().length >= need) return getCards();   // already loaded — no scroll, no jump
  for (let k = 0; k < (allowScroll ? 4 : 12) && getCards().length < need; k++) await sleep(250);
  if (getCards().length >= need || !allowScroll) return getCards();
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

// YouTube's own player endpoint answers with viewCount + publishDate in ~7 KB of JSON;
// the watch page costs ~1.7 MB for the same two numbers. Its config sits in an inline
// <script>, which we read out of the DOM — `window.ytcfg` is page-world only and a
// content script can't see it.
let innertube = null;
function innertubeConfig() {
  if (innertube !== null) return innertube;
  let src = "";
  for (const s of document.querySelectorAll("script")) {
    if (s.textContent && s.textContent.includes("INNERTUBE_API_KEY")) { src = s.textContent; break; }
  }
  const ver = (src.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) ||
               src.match(/"clientVersion":"([^"]+)"/) || [])[1];
  innertube = !ver ? false : {
    key: (src.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1] || "",
    context: { client: { clientName: "WEB", clientVersion: ver,
                         hl: (src.match(/"hl":"([^"]+)"/) || [])[1] || "en",
                         gl: (src.match(/"gl":"([^"]+)"/) || [])[1] || "US" } }
  };
  return innertube;
}

async function fetchViaPlayer(id) {
  const cfg = innertubeConfig();
  if (!cfg) return null;
  const res = await fetch("/youtubei/v1/player?prettyPrint=false" + (cfg.key ? "&key=" + cfg.key : ""), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ context: cfg.context, videoId: id })
  });
  if (!res.ok) return null;
  const j = await res.json();
  const details = (j && j.videoDetails) || null;
  const views = details ? details.viewCount : null;
  const micro = j && j.microformat ? j.microformat.playerMicroformatRenderer : null;
  const date = micro ? micro.publishDate : null;
  if (views == null && !date) return null;
  return { id, views: views != null ? parseInt(views, 10) : null, date: date || null,
           title: details ? details.title : null };
}

// Fallback. Note: no `credentials` override — YouTube refuses a credential-less fetch
// of the watch page outright ("Failed to fetch"), which is what made every lookup fail.
async function fetchViaWatchPage(id) {
  const res = await fetch(`https://www.youtube.com/watch?v=${id}`);
  const html = await res.text();
  const v = html.match(/"viewCount":"(\d+)"/);
  const d = html.match(/"publishDate":"([^"]+)"/);
  const t = html.match(/"videoDetails":\{[^}]*?"title":"((?:[^"\\]|\\.)*)"/);
  let title = null;
  if (t) { try { title = JSON.parse('"' + t[1] + '"'); } catch (e) {} }
  return { id, views: v ? parseInt(v[1], 10) : null, date: d ? d[1] : null, title };
}

const statInflight = new Map();   // so a background scan and a click never fetch the same id twice
async function fetchStats(id) {
  if (statCache.has(id)) return statCache.get(id);
  if (statInflight.has(id)) return statInflight.get(id);
  const job = (async () => {
    let result = null;
    try { result = await fetchViaPlayer(id); } catch (e) {}
    if (!result) { try { result = await fetchViaWatchPage(id); } catch (e) {} }
    result = result || { id, views: null, date: null };
    if (result.views != null || result.date) statCache.set(id, result);
    return result;
  })();
  statInflight.set(id, job);
  try { return await job; } finally { statInflight.delete(id); }
}
/* ---------- whole-channel video list (no scrolling) ----------
   The same browse endpoint that YouTube's own grid uses pages the Videos tab 30 at a
   time, so an entire channel can be walked without touching the user's scroll position. */
const VIDEOS_TAB_PARAMS = "EgZ2aWRlb3PyBgQKAjoA";
const SHORTS_TAB_PARAMS = "EgZzaG9ydHPyBgUKA5oBAA%3D%3D";

function getChannelId() {
  const tag = document.querySelector('link[rel="canonical"][href*="/channel/UC"], meta[itemprop="identifier"][content^="UC"]');
  if (tag) {
    const m = /(UC[\w-]{10,})/.exec(tag.getAttribute("href") || tag.getAttribute("content") || "");
    if (m) return m[1];
  }
  for (const s of document.querySelectorAll("script")) {
    const t = s.textContent;
    if (!t || t.indexOf("externalId") < 0) continue;
    const m = /"externalId":"(UC[\w-]+)"/.exec(t);
    if (m) return m[1];
  }
  return null;
}

async function browse(body) {
  const cfg = innertubeConfig();
  if (!cfg) return null;
  const res = await fetch("/youtubei/v1/browse?prettyPrint=false" + (cfg.key ? "&key=" + cfg.key : ""), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(Object.assign({ context: cfg.context }, body))
  });
  if (!res.ok) return null;
  return res.json();
}

// Reads ids out of the list bodies only, so the channel header, the featured video and
// the "for you" shelves don't get counted. Returns the token for the next page.
// The listing already carries an approximate "4.1M views · 10 days ago" per item. Too coarse
// to report, but exact enough to RANK — which is all Popular and Oldest need before deciding
// whose precise numbers are worth fetching.
const approxMeta = new Map();
const AGO_DAYS = { hour: 1 / 24, day: 1, week: 7, month: 30.44, year: 365.25 };
function parseApprox(parts) {
  let views = null, ageDays = null;
  for (const s of parts) {
    let m = /^([\d.,]+)\s*([KMB]?)\s*views?$/i.exec(s.trim());
    if (m) {
      const n = parseFloat(m[1].replace(/,/g, ""));
      const mult = { K: 1e3, M: 1e6, B: 1e9 }[m[2].toUpperCase()] || 1;
      if (isFinite(n)) views = n * mult;
      continue;
    }
    m = /^(\d+)\s+(hour|day|week|month|year)s?\s+ago$/i.exec(s.trim());
    if (m) ageDays = parseInt(m[1], 10) * AGO_DAYS[m[2].toLowerCase()];
  }
  return { views, ageDays };
}

function harvest(payload, seen, order) {
  let token = null;
  const walk = (o) => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    // Only the grid's own "load more" marker. Taking any continuationCommand found anywhere
    // picks up a shelf's token instead, which replays the same page over and over.
    const cir = o.continuationItemRenderer;
    const t = cir && cir.continuationEndpoint && cir.continuationEndpoint.continuationCommand &&
              cir.continuationEndpoint.continuationCommand.token;
    if (t) token = t;
    if (o.lockupViewModel && typeof o.lockupViewModel.contentId === "string" &&
        !approxMeta.has(o.lockupViewModel.contentId)) {
      const parts = [];
      (function collect(x) {
        if (!x || typeof x !== "object") return;
        if (Array.isArray(x)) return x.forEach(collect);
        if (x.text && typeof x.text.content === "string") parts.push(x.text.content);
        for (const k in x) collect(x[k]);
      })(o.lockupViewModel.metadata);
      approxMeta.set(o.lockupViewModel.contentId, parseApprox(parts));
    }
    const add = (id) => { if (id && id.length === 11 && !seen.has(id)) { seen.add(id); order.push(id); } };
    if (typeof o.videoId === "string") add(o.videoId);
    // Shorts sit in shortsLockupViewModel, which carries the id in these two spots instead
    if (typeof o.entityId === "string") {
      const m = /shorts-shelf-item-([\w-]{11})/.exec(o.entityId);
      if (m) add(m[1]);
    }
    if (o.onTap && o.onTap.innertubeCommand && o.onTap.innertubeCommand.reelWatchEndpoint)
      add(o.onTap.innertubeCommand.reelWatchEndpoint.videoId);
    for (const k in o) walk(o[k]);
  };
  walk(payload.contents);
  walk(payload.onResponseReceivedActions);
  return token;
}

// Walks the tab one page at a time and hands each page to the caller, who returns false to
// stop. Nothing downstream has to pull the whole channel just to answer a small question.
async function listTabPages(params, onPage) {
  const ch = getChannelId();
  if (!ch) return;
  let payload = await browse({ browseId: ch, params });
  let prevToken = null, stalls = 0;
  const seen = new Set();
  for (let page = 0; payload && page < 150; page++) {
    const order = [];
    const token = harvest(payload, seen, order);
    stalls = order.length ? 0 : stalls + 1;
    const keepGoing = await onPage(order, page);
    if (keepGoing === false || !token || token === prevToken || stalls >= 2) return;
    prevToken = token;
    payload = await browse({ continuation: token });
  }
}

// What the channel claims it has. Used only to notice when YouTube hands back a partial
// list, so we never state a first-upload date we can't stand behind.
function advertisedVideoCount() {
  // Scoped to the channel header — every video card carries a "… views" line that would
  // otherwise match too. YouTube renders this count in the DOM, not in the page's JSON.
  const header = document.querySelector("ytd-tabbed-page-header") ||
                 document.querySelector("tp-yt-app-header#header");
  if (!header) return null;
  const m = /([\d.,]+)\s*([KM]?)\s+videos/i.exec(header.textContent || "");
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  if (!isFinite(n)) return null;
  return Math.round(n * (m[2].toUpperCase() === "K" ? 1e3 : m[2].toUpperCase() === "M" ? 1e6 : 1));
}

// Long-form and Shorts live on separate tabs, and that separation IS the classification —
// YouTube's own split, not a duration guess. (A 117-second Short and a 117-second video are
// indistinguishable by length.)
const TAB_OF = { videos: VIDEOS_TAB_PARAMS, shorts: SHORTS_TAB_PARAMS };

// The whole point: a question about 10 videos, or about last month, should not cost a
// full-channel scan. Only "Popular"/"Oldest"/"All time" genuinely need every item.
async function datasetFor(opts, onProgress) {
  const kinds = opts.kind === "both" ? ["videos", "shorts"] : [opts.kind];
  const cutoff = opts.months ? monthsAgo(opts.months) : null;
  const topLatest = !cutoff && opts.n && opts.sort === "Latest";
  const needsEverything = !cutoff && !topLatest;
  // Popular and Oldest used to fetch every video just to sort them. Rank on the listing's own
  // approximate figures instead and fetch exact numbers for the shortlist only. A margin
  // covers the rounding ("4.1M" hides a 100k spread), and the caller re-sorts on real values.
  if (needsEverything && opts.n) {
    const cands = [];
    for (const k of kinds) {
      await listTabPages(TAB_OF[k], async (ids) => {
        ids.forEach((id) => cands.push(Object.assign(
          { id, kind: k === "shorts" ? "short" : "video" }, approxMeta.get(id) || {})));
        onProgress && onProgress(cands.length);
        return true;
      });
    }
    if (cands.length) {
      const by = opts.sort === "Popular"
        ? (a, b) => (b.views || 0) - (a.views || 0)
        : (a, b) => (b.ageDays || 0) - (a.ageDays || 0);
      const shortlist = cands.sort(by).slice(0, opts.n + 10);
      const picked = await mapPool(shortlist,
        (c) => fetchStats(c.id).then((s) => (s ? Object.assign({}, s, { kind: c.kind }) : null)), 6,
        onProgress ? (done, tot) => onProgress(done, done / tot) : null);
      return picked.filter((s) => s && (s.views != null || s.date));
    }
  }
  const out = [];
  for (const k of kinds) {
    let dry = 0, pages = 0, kept = 0;
    await listTabPages(TAB_OF[k], async (ids, page) => {
      pages = page + 1;
      if (!ids.length) return true;
      const stats = (await mapPool(ids, (id) => fetchStats(id), 6)).filter(Boolean);
      let fresh = 0;
      stats.forEach((s) => {
        if (s.views == null && !s.date) return;
        if (cutoff && !(s.date && new Date(s.date) >= cutoff)) return;
        out.push(Object.assign({}, s, { kind: k === "shorts" ? "short" : "video" }));
        fresh++; kept++;
      });
      onProgress && onProgress(out.length);
      if (needsEverything) return true;
      if (cutoff) { dry = fresh ? 0 : dry + 1; return !(pages >= 2 && dry >= 2); }
      return kept < opts.n;              // Top N by Latest: page 1 is newest-first
    });
  }
  return out;
}

/* ---------- one shared summary ----------
   Both paths (the cheap DOM read and the whole-channel scan) end up with the same shape —
   {id, title, views, date, kind} — so every figure the panel shows is computed once, here. */
function monthKey(d) { return d.getFullYear() * 12 + d.getMonth(); }
const MS_PER_MONTH = 1000 * 60 * 60 * 24 * 30.44;
const MAX_BUCKETS = 36;

function summarise(items) {
  const rows = items.filter((s) => s && s.views != null);
  if (!rows.length) return null;
  const sorted = rows.map((s) => s.views).sort((a, b) => a - b);
  const total = sorted.reduce((a, b) => a + b, 0);
  let top = null, bottom = null, vids = 0, shorts = 0;
  rows.forEach((s) => {
    if (s.kind === "short") shorts++; else vids++;
    if (!top || s.views > top.views) top = s;
    if (!bottom || s.views < bottom.views) bottom = s;
  });
  // Per-month and the monthly shape need dates; a run where YouTube gave us none still
  // reports the totals rather than blanking the whole strip.
  const dated = rows.filter((s) => s.date)
    .map((s) => ({ t: new Date(s.date), v: s.views }))
    .filter((d) => !isNaN(d.t))
    .sort((a, b) => a.t - b.t);
  let perMonth = null, from = null, to = null, buckets = [];
  if (dated.length) {
    from = dated[0].t;
    to = dated[dated.length - 1].t;
    perMonth = total / Math.max(1, (to - from) / MS_PER_MONTH);
    const first = monthKey(from), last = monthKey(to);
    const nb = Math.min(MAX_BUCKETS, last - first + 1);
    const step = (last - first + 1) / nb;
    buckets = new Array(nb).fill(0);
    dated.forEach((d) => { buckets[Math.min(nb - 1, Math.floor((monthKey(d.t) - first) / step))] += d.v; });
  }
  return { total, counted: rows.length, avg: total / rows.length,
           top, bottom, perMonth, from, to, buckets, vids, shorts,
           missing: items.length - rows.length };
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
      autoScanTimer = setTimeout(() => { observeCards(); topUp(); }, 400);
    });
    autoMutObserver.observe(document.body, { childList: true, subtree: true });
  }
  observeCards();
}

/* ---------- channel age ----------
   Two different clocks: when the channel was created (YouTube's "Joined" date, off the
   About page) and when it actually started publishing (the last entry of the newest-first
   listing). A dormant channel can have years between them. */
function ageLabel(d) {
  if (!d || isNaN(d)) return null;
  const now = new Date();
  let m = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
  if (now.getDate() < d.getDate()) m--;
  if (m < 0) m = 0;
  return `${Math.floor(m / 12)}y ${m % 12}m`;
}

let channelMeta = null;
function renderAges() {
  const cm = channelMeta;
  const joined = cm && cm.joined ? new Date(cm.joined) : null;
  setCell("ytva-age-ch", (joined && ageLabel(joined)) || "—");
  setCell("ytva-date-ch", cm && cm.joined ? " · created " + cm.joined : "");
  const first = cm && cm.first ? new Date(cm.first) : null;
  const label = first && ageLabel(first);
  setCell("ytva-age-fv", label ? (cm.partial ? "≥ " + label : label) : "—");
  setCell("ytva-date-fv", cm && cm.first
    ? (cm.partial ? " · oldest listed " : " · first upload ") + fmtDate(cm.first) : "");
  const el = document.getElementById("ytva-age-fv");
  if (el) el.title = cm && cm.partial
    ? `YouTube only returned ${cm.listed} of this channel's videos, so the real first upload may be older.`
    : "";
}

// The earliest upload can only be claimed off a listing that ran to the end of the tab, so
// only a run that scanned everything feeds it — the cheap Top-N runs stop far too early.
function noteFullScan(ch, stats) {
  if (!channelMeta || channelMeta.id !== ch || !stats.length) return;
  let first = null;
  stats.forEach((s) => {
    if (!s.date) return;
    if (!first || new Date(s.date) < new Date(first)) first = s.date;
  });
  if (!first) return;
  channelMeta.first = first;
  channelMeta.listed = stats.length;
  // YouTube sometimes hands back only a slice of a channel. Shorts and live streams live
  // on other tabs so some shortfall is normal, but a big one means we can't claim to have
  // seen the oldest video.
  const claimed = advertisedVideoCount();
  channelMeta.partial = !!(claimed && stats.length < claimed * 0.5);
  renderAges();
}

async function loadChannelAges() {
  const ch = getChannelId();
  if (!ch) return;
  if (channelMeta && channelMeta.id === ch) { renderAges(); return; }
  channelMeta = { id: ch, joined: null, first: null };
  renderAges();
  try {
    const html = await fetch(`https://www.youtube.com/channel/${ch}/about`).then((r) => r.text());
    const m = html.match(/"joinedDateText":\{[^}]*?"content":"(?:Joined\s+)?([^"]+)"/);
    if (m && channelMeta.id === ch) channelMeta.joined = m[1];
  } catch (e) {}
  renderAges();
}

/* ---------- top-up ----------
   The run that fires on page load never scrolls, so it can only see the rows YouTube has
   rendered so far. If that was short of N, redo it — for free, off the stat cache — once
   the user's own scrolling has brought enough cards into the DOM. */
let topUpTarget = 0;
function topUp() {
  if (!topUpTarget || running) return;
  if (!canReadFromPage()) { topUpTarget = 0; return; }   // the selection moved on — let it be
  if (getCards().length < topUpTarget) return;
  const n = topUpTarget;
  topUpTarget = 0;
  run(n, null, { auto: true });
}

/* ---------- current selection ----------
   scope decides which controls apply: "top" needs both the number and the sort, "months"
   only the number, "all" neither. Inapplicable controls are disabled, never hidden. */
let selectedSort = "Latest";
let selectedKind = "videos";
let selectedScope = "top";
// Once the user picks a kind, the tab we are standing on stops overriding it (until the
// channel changes). Without this, walking to /shorts would silently undo their choice.
let kindTouched = false;
let storedKind = "videos";   // last kind the user picked, read back from storage.sync
let tabKindApplied = false;  // the tab gets its say once per channel, not on every build

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
function isPanelPage() {
  return isChannelPage() && /\/(videos|shorts)\/?$/.test(location.pathname);
}
// The tab the user is standing on is the best guess at what they want counted.
function tabKind() {
  return /\/shorts\/?$/.test(location.pathname) ? "shorts" : "videos";
}
// Runs once per channel, and only after the stored selection has landed. The tab decides
// videos-vs-shorts; "Both" is the one choice no tab can express, so a stored "Both" is the
// only kind that survives standing on /videos or /shorts.
function applyTabKind() {
  if (kindTouched || tabKindApplied) return;
  tabKindApplied = true;
  selectedKind = storedKind === "both" ? "both" : tabKind();
}
function applyTheme(p) {
  p = p || document.getElementById(PANEL_ID);
  if (!p) return;
  const dark = document.documentElement.hasAttribute("dark");
  p.classList.toggle("ytva-dark", dark);
  p.classList.toggle("ytva-light", !dark);
}
const DEFAULT_N = { top: 10, months: 1, all: 10 };
function nInput() { return document.getElementById("ytva-n"); }
function clampN(v) {
  const max = selectedScope === "months" ? 600 : 200;
  return Math.max(1, Math.min(max, parseInt(v, 10) || DEFAULT_N[selectedScope]));
}
function currentN() { const i = nInput(); return clampN(i ? i.value : DEFAULT_N[selectedScope]); }
let settingsLoad = null;   // resolves once the stored selection has been applied

function buildPanel() {
  if (document.getElementById(PANEL_ID)) { placePanel(); return document.getElementById(PANEL_ID); }
  const p = document.createElement("div");
  p.id = PANEL_ID;
  p.className = "ytva-preinit";
  applyTheme(p);
  p.innerHTML = TT(`
    <div class="ytva-bar">
      <span class="ytva-mark">${BAR_SVG}</span>
      <div class="ytva-scopewrap">
        <span class="ytva-scope">YouTube Aggregator</span>
        <span class="ytva-sub" id="ytva-status"></span>
      </div>
      <div class="ytva-seg" id="ytva-kind" role="group" aria-label="Content type">
        <button type="button" data-kind="videos" aria-pressed="true">Videos</button>
        <button type="button" data-kind="shorts" aria-pressed="false">Shorts</button>
        <button type="button" data-kind="both" aria-pressed="false">Both</button>
      </div>
      <button type="button" id="ytva-toggle" class="ytva-acc" aria-expanded="true"
              aria-controls="ytva-body" title="Collapse panel">${CHEV_SVG}</button>
    </div>

    <!-- Three genuinely different questions, so three modes. Each one shows only its own
         controls; nothing irrelevant is left on screen to be read and dismissed. -->
    <div class="ytva-tabs" role="tablist" aria-label="What to aggregate">
      <button type="button" role="tab" data-scope="top" id="ytva-tab-top"
              aria-selected="true" aria-controls="ytva-tabrow" tabindex="0">Top N</button>
      <button type="button" role="tab" data-scope="months" id="ytva-tab-months"
              aria-selected="false" aria-controls="ytva-tabrow" tabindex="-1">Last N months</button>
      <button type="button" role="tab" data-scope="all" id="ytva-tab-all"
              aria-selected="false" aria-controls="ytva-tabrow" tabindex="-1">All time</button>
    </div>
    <div class="ytva-tabrow" id="ytva-tabrow" role="tabpanel" aria-labelledby="ytva-tab-top">
      <div class="ytva-modectl" data-scope="top">
        <label class="ytva-vh" for="ytva-n">How many</label>
        <span class="ytva-lead">Top</span>
        <input id="ytva-n" type="number" min="1" max="600" value="10"/>
        <div class="ytva-seg" id="ytva-sort" role="group" aria-label="Sort">
          <button type="button" data-sort="Latest" aria-pressed="true">Latest</button>
          <button type="button" data-sort="Popular" aria-pressed="false">Popular</button>
          <button type="button" data-sort="Oldest" aria-pressed="false">Oldest</button>
        </div>
      </div>
      <div class="ytva-modectl" data-scope="months" hidden>
        <span class="ytva-lead">Published in the last</span>
        <span class="ytva-monthsbox"></span>
        <span class="ytva-lead">months</span>
      </div>
      <div class="ytva-modectl" data-scope="all" hidden>
        <span class="ytva-lead">Every video on the channel</span>
      </div>
      <button type="button" id="ytva-calc" class="ytva-go"><span class="ytva-spinner" aria-hidden="true"></span><span class="ytva-go-label">Calculate</span></button>
    </div>
    <div class="ytva-progress" id="ytva-progress"><div class="ytva-progress-fill" id="ytva-progress-fill"></div></div>
    <div class="ytva-accbody" id="ytva-body"><div class="ytva-accinner">
      <div class="ytva-cols">
        <div class="ytva-col">
          <span class="ytva-lbl">Total views</span>
          <div class="ytva-hero num" id="ytva-total">—</div>
          <span class="ytva-sub num" id="ytva-total-ind"></span>
        </div>
        <div class="ytva-col">
          <span class="ytva-lbl" id="ytva-avg-label">Average per video</span>
          <div class="ytva-hero num" id="ytva-avg">—</div>
          <span class="ytva-sub" id="ytva-avg-exact"></span>
        </div>
        <div class="ytva-col">
          <span class="ytva-lbl" id="ytva-third-label">Per month</span>
          <div class="ytva-hero num" id="ytva-permonth">—</div>
          <span class="ytva-sub" id="ytva-permonth-sub"></span>
        </div>
        <div class="ytva-col" id="ytva-sparkcol">
          <span class="ytva-lbl">Views by month</span>
          <div class="ytva-spark" id="ytva-spark" aria-hidden="true"></div>
          <div class="ytva-sparkaxis">
            <span class="ytva-sub" id="ytva-spark-from"></span>
            <span class="ytva-sub" id="ytva-spark-to"></span>
          </div>
        </div>
      </div>
      <div class="ytva-pair">
        <div class="ytva-col">
          <span class="ytva-lbl">Highest</span>
          <a class="ytva-ent" id="ytva-top-title" target="_blank" rel="noopener noreferrer">—</a>
          <span class="ytva-sub" id="ytva-top-exact"></span>
        </div>
        <div class="ytva-col">
          <span class="ytva-lbl">Lowest</span>
          <a class="ytva-ent" id="ytva-low-title" target="_blank" rel="noopener noreferrer">—</a>
          <span class="ytva-sub" id="ytva-low-exact"></span>
        </div>
      </div>
      <div class="ytva-foot">
        <span>Channel age <b class="num" id="ytva-age-ch">—</b><span id="ytva-date-ch"></span></span>
        <span>Publishing for <b class="num" id="ytva-age-fv">—</b><span id="ytva-date-fv"></span></span>
        <span id="ytva-exact"></span>
      </div>
    </div></div>`);
  placePanel(p);

  // The first run must not fire before the stored selection lands, or it would answer a
  // question the user didn't ask (and then be replaced a beat later).
  settingsLoad = new Promise((resolve) => {
    chrome.storage.sync.get({ ytvaN: DEFAULT_N.top, ytvaScope: "top", ytvaKind: "videos" }, (d) => {
      selectedScope = ["top", "months", "all"].indexOf(d.ytvaScope) < 0 ? "top" : d.ytvaScope;
      storedKind = ["videos", "shorts", "both"].indexOf(d.ytvaKind) < 0 ? "videos" : d.ytvaKind;

      const inp = nInput();
      if (inp) inp.value = clampN(d.ytvaN);
      syncControls();
      resolve();
    });
  });

  selectedSort = detectActiveSort();
  syncControls();

  p.querySelectorAll("#ytva-sort button").forEach((b) => {
    b.onclick = () => {
      if (running) return;
      selectedSort = b.dataset.sort;
      syncControls();
      // Our own numbers no longer depend on YouTube's sort control, but the user still
      // expects the page under the panel to follow along. Best effort: click the chip if the
      // channel renders one, and carry on regardless if it does not.
      selectSort(selectedSort);
      runSelection();
    };
  });
  p.querySelectorAll("#ytva-kind button").forEach((b) => {
    b.onclick = () => {
      if (running) return;
      selectedKind = b.dataset.kind;
      kindTouched = true;
      storedKind = selectedKind;
      syncControls();
      chrome.storage.sync.set({ ytvaKind: selectedKind });
      runSelection();
    };
  });
  p.querySelectorAll(".ytva-tabs [role=tab]").forEach((tab) => {
    tab.onclick = () => selectScope(tab.dataset.scope);
    tab.onkeydown = (e) => {                    // roving focus, as a real tablist should
      const order = ["top", "months", "all"];
      const i = order.indexOf(tab.dataset.scope);
      const next = e.key === "ArrowRight" ? order[(i + 1) % 3]
                 : e.key === "ArrowLeft" ? order[(i + 2) % 3] : null;
      if (!next) return;
      e.preventDefault();
      selectScope(next);
      p.querySelector(`#ytva-tab-${next}`).focus();
    };
  });
  function selectScope(scope) {
    if (running || scope === selectedScope) return;
    selectedScope = scope;
    const inp = nInput();
    const inp2 = nInput();
    if (inp2 && selectedScope !== "all") inp2.value = DEFAULT_N[selectedScope];
    syncControls();
    chrome.storage.sync.set({ ytvaScope: selectedScope, ytvaN: currentN() });
  };
  p.querySelector("#ytva-n").addEventListener("input", () => syncScopeLine());
  p.querySelector("#ytva-n").addEventListener("keydown", (e) => {
    if (e.key === "Enter") p.querySelector("#ytva-calc").click();
  });
  p.querySelector("#ytva-calc").onclick = () => {
    const inp = nInput();
    if (inp) inp.value = currentN();
    chrome.storage.sync.set({ ytvaN: currentN(), ytvaScope: selectedScope });
    runSelection();
  };
  p.querySelector("#ytva-toggle").onclick = () => toggleCollapse(true);

  // Nothing is shown until the stored collapse state is known, so a panel the user left
  // collapsed never flashes open — and the fixed header never measures a height we drop.
  collapsedLoad.then(() => {
    applyCollapsed();
    p.classList.remove("ytva-preinit");
    syncHeader();
  });
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
  watchPanelHeight(p);
  syncHeader();
}

/* ---------- keep YouTube's collapsing header in sync ----------
   The panel lives inside `tp-yt-app-header`, which is position:fixed and caches how far
   it may translate up while you scroll (that cache is measured once, from the header's
   height at the time). Growing the header with our panel and leaving the cache stale
   pins a tall fixed strip over the grid: cards scroll underneath it and show through the
   transparent gaps, and the content offset jumps. Ask Polymer to re-measure whenever our
   height changes. */
let headerSyncTimer = null;
function syncHeader() {
  clearTimeout(headerSyncTimer);
  headerSyncTimer = setTimeout(() => {
    const hdr = document.querySelector("tp-yt-app-header#header") ||
                document.querySelector("tp-yt-app-header");
    if (!hdr) return;
    if (typeof hdr.resetLayout === "function") { try { hdr.resetLayout(); } catch (e) {} }
    else if (typeof hdr.notifyResize === "function") { try { hdr.notifyResize(); } catch (e) {} }
  }, 60);
}

let panelSizeObserver = null;
function watchPanelHeight(p) {
  if (!window.ResizeObserver || !p) return;
  if (!panelSizeObserver) panelSizeObserver = new ResizeObserver(syncHeader);
  else panelSizeObserver.disconnect();
  panelSizeObserver.observe(p);
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

/* ---------- controls ----------
   Every control keeps its box at every moment: the ones that don't apply to the current
   range are disabled (which also drops them out of the tab order), never hidden, so
   switching the range can't reflow the bar. */
function syncControls() {
  syncShortsAvailability();
  const kindBar = document.getElementById("ytva-kind");
  if (kindBar) kindBar.querySelectorAll("button").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.kind === selectedKind)));
  const sortBar = document.getElementById("ytva-sort");
  const sortApplies = true;
  if (sortBar) sortBar.querySelectorAll("button").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.sort === selectedSort));
    b.disabled = !sortApplies;
  });
  const inp = nInput();
  // The months box borrows the same input so N survives a mode switch.
  const box = document.querySelector(".ytva-monthsbox");
  const inp3 = document.getElementById("ytva-n");
  if (box && inp3 && selectedScope === "months" && inp3.parentElement !== box) box.appendChild(inp3);
  const topCtl = document.querySelector('.ytva-modectl[data-scope="top"]');
  if (topCtl && inp3 && selectedScope === "top" && inp3.parentElement !== topCtl)
    topCtl.insertBefore(inp3, topCtl.querySelector("#ytva-sort"));
  document.querySelectorAll(".ytva-modectl").forEach((m) => { m.hidden = m.dataset.scope !== selectedScope; });
  document.querySelectorAll(".ytva-tabs [role=tab]").forEach((tb) => {
    const on = tb.dataset.scope === selectedScope;
    tb.setAttribute("aria-selected", String(on));
    tb.tabIndex = on ? 0 : -1;
  });
  const row = document.getElementById("ytva-tabrow");
  if (row) row.setAttribute("aria-labelledby", `ytva-tab-${selectedScope}`);
  syncScopeLine();
}

function scopeSentence() {
  const kindWord = selectedKind === "both" ? "videos + shorts" : selectedKind;
  if (selectedScope === "all") return `All time · ${kindWord}`;
  const n = currentN();
  if (selectedScope === "months") return `Last ${n} month${n > 1 ? "s" : ""} · ${kindWord}`;
  return `Top ${n} · ${selectedSort} · ${kindWord}`;
}
// Plenty of channels have no Shorts at all. Offering the toggle there is a lie, so the
// options are disabled — kept in place, per the no-shift rule, rather than removed.
function channelHasShorts() {
  const header = document.querySelector("ytd-tabbed-page-header") ||
                 document.querySelector("tp-yt-app-header#header");
  if (!header) return true;                       // header not up yet — assume yes, re-checked later
  const tabs = [...header.querySelectorAll("yt-tab-shape, tp-yt-paper-tab, a")]
    .map((e) => (e.textContent || "").trim().toLowerCase());
  if (!tabs.length) return true;
  return tabs.some((x) => x === "shorts");
}
function syncShortsAvailability() {
  const bar = document.getElementById("ytva-kind");
  if (!bar) return;
  const has = channelHasShorts();
  bar.querySelectorAll("button").forEach((b) => {
    const needsShorts = b.dataset.kind !== "videos";
    b.disabled = needsShorts && !has;
    b.setAttribute("aria-disabled", String(b.disabled));
    b.title = b.disabled ? "This channel has no Shorts" : "";
  });
  if (!has && selectedKind !== "videos") { selectedKind = "videos"; highlightKind(); }
}

function syncScopeLine() {}   // the title is fixed; the status line carries the context
function setStatus(msg) { setCell("ytva-status", msg || ""); }
// Wraps a panel writer so only the run that still holds the ticket may use it.
function mine(gen, fn) { return (v) => { if (gen === runGen) fn(v); }; }
function setCell(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }

/* ---------- accordion ----------
   Collapsing changes the panel's height, and the panel lives inside YouTube's fixed header
   — so every toggle has to end in syncHeader() (see the note there). */
let collapsed = false;
const collapsedLoad = new Promise((resolve) => {
  try { chrome.storage.local.get({ ytvaCollapsed: false }, (d) => { collapsed = !!(d && d.ytvaCollapsed); resolve(); }); }
  catch (e) { resolve(); }
});
function applyCollapsed() {
  const body = document.getElementById("ytva-body");
  const btn = document.getElementById("ytva-toggle");
  // The body is only clipped to zero height, so without `inert` its links would stay
  // tabbable (and scroll the clipped box into view) while aria-expanded says it is closed.
  if (body) { body.dataset.collapsed = String(collapsed); body.inert = collapsed; }
  if (btn) {
    btn.setAttribute("aria-expanded", String(!collapsed));
    btn.title = collapsed ? "Expand panel" : "Collapse panel";
  }
  syncHeader();
}
// `fromButton` keeps focus where the user left it; the toolbar-icon path must not yank
// focus (and the page with it) down to the panel.
function toggleCollapse(fromButton) {
  collapsed = !collapsed;
  applyCollapsed();
  try { chrome.storage.local.set({ ytvaCollapsed: collapsed }); } catch (e) {}
  const btn = document.getElementById("ytva-toggle");
  if (fromButton && btn) btn.focus();
}

function setProgress(pct) {
  const f = document.getElementById("ytva-progress-fill");
  if (f) f.style.width = Math.max(0, Math.min(100, pct)) + "%";
}
// The button's label never changes: "Calculating…" is two characters wider than
// "Calculate" and would resize the bar mid-run. The progress line says it instead.
function setBusy(on) {
  const p = document.getElementById(PANEL_ID);
  if (p) p.classList.toggle("ytva-busy", on);
  const btn = document.getElementById("ytva-calc");
  if (btn) btn.disabled = on;
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
// Tabular figures are for numerals only, so the trailing word ("each", "views") sits outside
// the .num span instead of being rendered in the monospace face.
function setMeasure(id, value, unit) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = "";
  if (value == null || value === "") return;
  const num = document.createElement("span");
  num.className = "num";
  num.textContent = value;
  el.appendChild(num);
  el.appendChild(document.createTextNode(` ${unit}`));
}
// One hue, one variable: bar height. Built as elements so the panel keeps a single
// innerHTML (the Trusted-Types one).
function renderSpark(buckets) {
  const el = document.getElementById("ytva-spark");
  if (!el) return;
  el.textContent = "";
  if (!buckets || !buckets.length) return;
  const max = Math.max.apply(null, buckets.concat([1]));
  buckets.forEach((v) => {
    const bar = document.createElement("i");
    bar.style.height = Math.max(2, (v / max) * 100) + "%";
    el.appendChild(bar);
  });
}

const BLANKS = ["ytva-total-ind", "ytva-avg-exact", "ytva-permonth-sub",
                "ytva-spark-from", "ytva-spark-to", "ytva-top-exact", "ytva-low-exact", "ytva-exact"];
function renderResults(r, kind) {
  const noun = KIND_WORD[kind || selectedKind];
  setCell("ytva-avg-label", `Average per ${noun}`);
  if (!r) {
    ["ytva-total", "ytva-avg", "ytva-permonth"].forEach((id) => setCell(id, "—"));
    BLANKS.forEach((id) => setCell(id, ""));
    setLink("ytva-top-title", "—", null);
    setLink("ytva-low-title", "—", null);
    renderSpark(null);
    return;
  }
  const avgR = Math.round(r.avg);
  // prominent = 2-decimal rounded (M/K); the Indian reading and the exact figure sit below
  setCell("ytva-total", abIntl2(r.total));
  setCell("ytva-total-ind", abInd2(r.total) || "");
  setCell("ytva-avg", abIntl2(avgR));
  setMeasure("ytva-avg-exact", fmtExact(avgR), "each");
  const buckets = (r.buckets || []).length;
  if (selectedScope === "months") {
    const w = KIND_WORD[selectedKind]; setCell("ytva-third-label", w[0].toUpperCase() + w.slice(1) + "s");
    setCell("ytva-permonth", String(r.counted));
    setCell("ytva-permonth-sub", r.from ? `published ${fmtMonth(r.from)} – ${fmtMonth(r.to)}` : "");
  } else {
    setCell("ytva-third-label", "Per month");
    setCell("ytva-permonth", r.perMonth == null ? "—" : abIntl2(Math.round(r.perMonth)));
    setCell("ytva-permonth-sub", r.from ? `across ${fmtMonth(r.from)} – ${fmtMonth(r.to)}` : "");
  }
  // One bar is not a shape — drop the column rather than show a lone rectangle.
  const sparkCol = document.getElementById("ytva-sparkcol");
  if (sparkCol) sparkCol.hidden = buckets < 2;
  const cols = document.querySelector(".ytva-cols");
  if (cols) cols.classList.toggle("ytva-cols-3", buckets < 2);
  renderSpark(r.buckets);
  setCell("ytva-spark-from", r.from ? fmtMonth(r.from) : "");
  setCell("ytva-spark-to", r.to ? fmtMonth(r.to) : "");
  setLink("ytva-top-title", r.top.title, r.top.id);
  setMeasure("ytva-top-exact", fmtExact(r.top.views), "views");
  setLink("ytva-low-title", r.bottom.title, r.bottom.id);
  setMeasure("ytva-low-exact", fmtExact(r.bottom.views), "views");
  setCell("ytva-exact", `${fmtExact(r.total)} views exactly`);
}

// The sample size belongs to the scope, not to the exact-total line.
function countText(r, kind) {
  const base = kind === "both"
    ? `${r.vids} video${r.vids === 1 ? "" : "s"} + ${r.shorts} short${r.shorts === 1 ? "" : "s"}`
    : `${r.counted} ${KIND_WORD[kind]}${r.counted === 1 ? "" : "s"}`;
  return r.missing ? `${base} · ${r.missing} skipped` : base;
}

/* ---------- main run ---------- */
let running = false;
let pendingRun = null;     // a selection asked for while the mutex was held (see runSelection)
function drainPending() {
  if (!pendingRun) return;
  const opts = pendingRun;
  pendingRun = null;
  runSelection(opts);
}
// Every run takes a ticket. A reply that comes back after a newer run started, or after the
// user moved to another channel, is dropped instead of painting stale numbers.
let runGen = 0;
let lastChannelId = null;
function resetForChannel() {
  runGen++;
  channelMeta = null;
  topUpTarget = 0;
  kindTouched = false;      // a new channel gets the tab's kind again
  renderResults(null);
  renderAges();
  syncScopeLine();
  setStatus("Loading…");
}

// The page's own grid is only the long-form list on /videos, so the cheap DOM read applies
// to exactly one selection: Top N videos on that tab. Everything else scans the channel.
// Reading the rendered grid is only safe for the order it is already in. Popular and Oldest
// used to be reached by clicking YouTube's own sort control, which some channels render as a
// dropdown instead of chips — there it silently did nothing. We hold every video's views and
// date anyway, so those two orders are computed here rather than asked for.
function canReadFromPage() {
  return selectedScope === "top" && selectedKind === "videos" &&
         selectedSort === "Latest" && /\/videos\/?$/.test(location.pathname);
}
function runSelection(opts) {
  // A run asked for while another is in flight (a channel switch mid-scan, above all) is
  // remembered, not dropped: the old run's reply is refused by the generation guard, so if
  // this one were swallowed too the panel would sit on "Loading…" with nothing to retry it.
  if (running) { pendingRun = opts || {}; return Promise.resolve(); }
  const n = currentN();
  if (canReadFromPage()) return run(n, selectedSort, opts);
  return runDataset({
    months: selectedScope === "months" ? n : null,
    kind: selectedKind,
    n: selectedScope === "top" ? n : null,
    sort: selectedSort
  });
}

async function run(n, sort, opts) {
  if (running) return;
  running = true;
  const gen = ++runGen, chan = getChannelId();
  // A superseded run must stop narrating: its progress lines would otherwise keep writing
  // into the header bar of the channel that replaced it.
  const say = mine(gen, setStatus), tick = mine(gen, setProgress);
  setBusy(true);
  setProgress(6);
  syncScopeLine();
  try {
    if (sort && sort !== detectActiveSort()) {
      say(`Sorting by ${sort}…`);
      await selectSort(sort);
      observeCards();
    }
    say("Loading videos…");
    const cards = (await ensureCards(n, !(opts && opts.auto))).slice(0, n);
    if (!cards.length) { say("No videos found here."); return; }
    const meta = cards.map((c) => ({ card: c, id: getVideoId(c), title: getTitle(c) }));
    say(`Fetching 0/${cards.length}…`);
    const stats = await mapPool(meta, (m) => fetchStats(m.id), 4,
      (done, tot) => { say(`Fetching ${done}/${tot}…`); tick((done / tot) * 100); });

    const items = stats.map((s, i) => {
      injectDate(meta[i].card, s);
      return { id: meta[i].id, title: (s && s.title) || meta[i].title,
               views: s ? s.views : null, date: s ? s.date : null, kind: "video" };
    });
    if (gen !== runGen || chan !== getChannelId()) return;
    const r = summarise(items);
    if (!r) { say("Couldn't read views — try again."); return; }
    renderResults(r, "videos");
    syncScopeLine();
    say(countText(r, "videos"));
    topUpTarget = opts && opts.auto && cards.length < n ? n : 0;
  } finally {
    running = false;
    setBusy(false);
    drainPending();
  }
}

// Whole-channel modes. `months` null = every video; a number = only videos published
// within that many months. Both read the same dataset, so the second one is instant.
function monthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d;
}
async function runDataset(opts) {
  if (running) return;
  const { months, kind, n, sort } = opts;
  running = true;
  topUpTarget = 0;
  setBusy(true);
  setProgress(3);
  syncScopeLine();
  try {
    const gen = ++runGen, chan = getChannelId();
    const say = mine(gen, setStatus), tick = mine(gen, setProgress);
    say("Reading channel…");
    let ticks = 0;
    const stats = await datasetFor({ kind, months, n: n, sort },
      (got) => { say(`Read ${got}…`); tick(Math.min(92, (ticks += 4))); });
    if (gen !== runGen || chan !== getChannelId()) return;   // superseded, or we moved channel
    if (!stats.length) {
      renderResults(null);          // never leave stale figures under a failure message
      // An empty month window is a real answer, not a failure — the old wording claimed the
      // channel could not be listed, which sent people hunting for a bug that wasn't there.
      say(months
        ? `Nothing published in the last ${months} month${months > 1 ? "s" : ""}`
        : "Couldn't read this channel's videos.");
      return;
    }
    // Only a run that walked the tabs end to end can speak for the oldest upload.
    if (!months && (!n || sort !== "Latest")) noteFullScan(chan, stats);

    let set = stats;
    if (months) {
      const cutoff = monthsAgo(months);
      set = set.filter((s) => s.date && new Date(s.date) >= cutoff);
      if (!set.length) {
        renderResults(null, kind);
        say("nothing published in this window");
        return;
      }
    }
    if (n && set.length > n) {
      const by = sort === "Popular" ? (a, b) => (b.views || 0) - (a.views || 0)
               : sort === "Oldest" ? (a, b) => new Date(a.date || 0) - new Date(b.date || 0)
               : (a, b) => new Date(b.date || 0) - new Date(a.date || 0);
      set = set.slice().sort(by).slice(0, n);
    }

    const r = summarise(set.map((s) => Object.assign({}, s, { title: s.title || "(untitled)" })));
    if (!r) { say("Couldn't read views — try again."); return; }
    renderResults(r, kind);
    syncScopeLine();
    say(countText(r, kind));
  } finally {
    running = false;
    setBusy(false);
    drainPending();
  }
}

/* ---------- lifecycle (YouTube SPA) ---------- */
let autoRan = false;
async function maybeInject() {
  if (!isPanelPage()) {
    const old = document.getElementById(PANEL_ID);
    if (old) { panelSizeObserver?.disconnect(); old.remove(); syncHeader(); }
    return;
  }
  // A different channel must never keep the previous one's numbers on screen, not even for
  // a frame — blank first, then load.
  const ch = getChannelId();
  if (ch && ch !== lastChannelId) { lastChannelId = ch; autoRan = false; tabKindApplied = false; resetForChannel(); }
  // wait briefly for the header/grid to exist
  for (let k = 0; k < 25 && !document.querySelector("tp-yt-app-toolbar"); k++) await sleep(300);
  const p = buildPanel();
  applyTheme(p);
  // Stored selection first, then the tab's say over the kind — the other order would make the
  // restore unreachable, since the tab claims a kind on every panel build.
  if (settingsLoad) await settingsLoad;
  applyTabKind();
  syncControls();
  startAutoDates();
  if (!autoRan) {
    autoRan = true;
    for (let k = 0; k < 20 && getCards().length < 1; k++) await sleep(300);
    await runSelection({ auto: true });
  }
  loadChannelAges();   // after the visible numbers, so it never competes with them
}
maybeInject();
// The channel id lives in the DOM, which lags a SPA navigation, and maybeInject waits another
// 400ms for the header — for that whole window the previous channel's totals stay on screen.
// The URL changes first, so key the reset off the handle in the path and blank immediately.
let lastHandle = null;
function currentHandle() {
  const m = /^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)/.exec(location.pathname);
  return m ? m[1] : null;
}
function onNavigate() {
  const h = currentHandle();
  if (h === lastHandle) return;
  lastHandle = h;
  autoRan = false;
  tabKindApplied = false;
  lastChannelId = null;          // force maybeInject's own check to fire too
  if (document.getElementById(PANEL_ID)) resetForChannel();
}
lastHandle = currentHandle();
["yt-navigate-start", "yt-navigate", "yt-navigate-finish"].forEach((ev) =>
  window.addEventListener(ev, onNavigate));

window.addEventListener("yt-navigate-finish", () => { autoRan = false; setTimeout(maybeInject, 400); });
document.addEventListener("yt-page-data-updated", () => setTimeout(() => { placePanel(); observeCards(); }, 400));

let alignTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(alignTimer);
  alignTimer = setTimeout(() => { alignPanel(); syncHeader(); }, 120);
});
// YouTube's collapsing header can settle a beat after load — realign a couple of times.
[600, 1200, 2000].forEach((t) => setTimeout(() => { alignPanel(); syncHeader(); }, t));

// keep theme in sync with YouTube's dark/light toggle — toggling the two theme classes
// only, so the busy/preinit state on the panel survives a theme flip
new MutationObserver(() => applyTheme()).observe(document.documentElement,
  { attributes: true, attributeFilter: ["dark"] });

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg && msg.type === "YTVA_TOGGLE") {
    if (!document.getElementById(PANEL_ID)) maybeInject();
    else toggleCollapse(false);
    sendResponse({ ok: true });
  }
  return true;
});
