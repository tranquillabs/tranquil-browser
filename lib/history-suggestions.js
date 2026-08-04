// URL-bar suggestion engine.
//
// History suggestions aggregate EVERY window's visit log (jStorage keys
// `bp.history.<windowSessionId>`): window session isolation exists to keep
// cookie/login jars apart, not to hide one window's browsing from another —
// the same trade-off as Firefox containers, where history and address-bar
// suggestions are shared across containers. Entries are ranked by frecency
// (visit count weighted by recency) with a boost for URLs the user explicitly
// typed (`bp.typedUrls`); the view's autocomplete source merges them with
// favorites and DuckDuckGo search suggestions.
//
// jStorage facts this module is built around:
//   - `js.get()` returns live references into jStorage's in-memory cache —
//     the index walk is strictly read-only (writers like recordTypedUrl use
//     addHistory's mutate-then-set pattern instead).
//   - Writes from other windows arrive automatically via jStorage's
//     storage-event observer, so cross-window freshness needs no manual
//     localStorage parsing; the cache below only avoids re-aggregating on
//     every keystroke.
const fs = require("fs");
const path = require("path");
const https = require("https");

const TYPED_KEY = "bp.typedUrls";
const TYPED_CAP = 200; // tracked typed URLs; oldest-by-last-use evicted
const INDEX_TTL_MS = 30 * 1000;
const MAX_AGE_DAYS = 90; // ignore day-buckets older than this
const MAX_ENTRIES_PER_KEY = 5000; // hard cap per window's history array

const bpjs = () => (window.bp && window.bp.js) || null;

// ---------------------------------------------------------------- URL helpers

// Canonical form for typed-URL keys, cross-source dedupe, and row display:
// scheme, leading "www." and trailing slashes stripped; host lowercased (path
// and query keep their case). "https://www.GitHub.com/X/" and
// "http://github.com/X" both normalize to "github.com/X".
function normalizeUrl(u) {
  const s = String(u || "")
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/+$/, "");
  const slash = s.indexOf("/");
  return slash === -1
    ? s.toLowerCase()
    : s.slice(0, slash).toLowerCase() + s.slice(slash);
}

// A DuckDuckGo navigation (search results / homepage) — never a "typed URL".
function isSearchUrl(u) {
  return /^https?:\/\/(www\.)?duckduckgo\.com\//i.test(String(u || ""));
}

// Only real pages are suggestible. addHistory already skips the internal
// pages, but older stores can hold blob:/about: leftovers, and data: URIs can
// be enormous.
function isSuggestibleUri(uri) {
  return /^(https?|file):\/\//i.test(uri) && uri.length <= 2048;
}

// -------------------------------------------- history index (merged per URI)

let cache = null; // { builtAt, entries }

function invalidate() {
  cache = null;
}

// Firefox-like recency buckets: a visit today counts far more than one months
// ago.
function visitWeight(ageDays) {
  if (ageDays <= 0) return 100;
  if (ageDays <= 7) return 70;
  if (ageDays <= 30) return 50;
  return 30;
}

// History entries store `date` as a locale STRING (see addHistory), so
// recency comes from the "YYYYMMDD" day-bucket key alone — never parse entry
// dates.
function bucketAgeDays(dayKey, todayMs) {
  const y = +dayKey.slice(0, 4);
  const m = +dayKey.slice(4, 6);
  const d = +dayKey.slice(6, 8);
  if (!y || !m || !d) return Infinity;
  return Math.round((todayMs - new Date(y, m - 1, d).getTime()) / 86400000);
}

function buildIndex() {
  const js = bpjs();
  if (!js) return [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();
  const titles = js.get("bp.title") || {};
  const typed = js.get(TYPED_KEY) || {};
  const perUri = new Map();
  let ord = 0;

  const keys = js
    .index()
    .filter((k) => k === "bp.history" || k.indexOf("bp.history.") === 0);
  for (const key of keys) {
    const hist = js.get(key); // live reference — read-only walk
    if (!Array.isArray(hist)) continue;
    let scanned = 0;
    for (const bucket of hist) {
      const dayKey = bucket && Object.keys(bucket)[0];
      if (!dayKey) continue;
      const age = bucketAgeDays(dayKey, todayMs);
      if (age > MAX_AGE_DAYS) break; // buckets are newest-first
      const weight = visitWeight(age);
      const dayNum = +dayKey || 0;
      for (const entry of bucket[dayKey] || []) {
        if (++scanned > MAX_ENTRIES_PER_KEY) break;
        const uri = entry && entry.uri;
        if (!uri || !isSuggestibleUri(uri)) continue;
        let rec = perUri.get(uri);
        if (!rec) {
          const norm = normalizeUrl(uri);
          rec = {
            uri,
            norm,
            title: titles[uri] || "",
            base: 0,
            lastDay: dayNum,
            ord: ord++, // scan order = recency (newest entries first)
            typed: typed[norm] || null,
          };
          rec.hay = (norm + " " + rec.title).toLowerCase();
          perUri.set(uri, rec);
        }
        rec.base += weight;
        if (dayNum > rec.lastDay) rec.lastDay = dayNum;
      }
      if (scanned > MAX_ENTRIES_PER_KEY) break;
    }
  }
  return Array.from(perUri.values());
}

function getIndex() {
  if (!cache || Date.now() - cache.builtAt > INDEX_TTL_MS) {
    cache = { builtAt: Date.now(), entries: buildIndex() };
  }
  return cache.entries;
}

// -------------------------------------------------- matching + frecency rank

// Case-insensitive substring match over "normalized URL + title".
// score = Σ visitWeight(age)                 (frecency base)
//         ×2 when the term prefixes the normalized URL (host-prefix match)
//         +400 + 200·min(typedCount, 8) for explicitly typed URLs — additive,
//           so one typed visit decisively beats a few incidental page views,
//           while a page visited dozens of times a day can still take the top
//           slot.
function historySuggestions(term, limit) {
  const q = String(term || "").trim().toLowerCase();
  if (q.length < 2) return [];
  const scored = [];
  for (const e of getIndex()) {
    if (e.hay.indexOf(q) === -1) continue;
    let score = e.base;
    if (e.norm.toLowerCase().indexOf(q) === 0) score *= 2;
    if (e.typed) score += 400 + 200 * Math.min(e.typed.n || 1, 8);
    scored.push({ e, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score || b.e.lastDay - a.e.lastDay || a.e.ord - b.e.ord
  );
  // http/https and www variants of one page collapse into the best-scored row.
  const out = [];
  const seen = new Set();
  for (const { e } of scored) {
    if (seen.has(e.norm)) continue;
    seen.add(e.norm);
    out.push({
      label: e.title || e.norm,
      value: e.uri, // keyboard fill + select navigate to the real URI
      kind: "history",
      title: e.title,
      display: e.norm,
    });
    if (out.length >= (limit || 6)) break;
  }
  return out;
}

// Phase-1 (synchronous) items: history first, then matching favorites.
function localSuggestions(term, historyLimit, totalLimit) {
  const items = historySuggestions(term, historyLimit);
  const seen = new Set(items.map((i) => normalizeUrl(i.value)));
  const js = bpjs();
  const q = String(term || "").toLowerCase();
  for (const fav of (js && js.get("bp.fav")) || []) {
    if (items.length >= totalLimit) break;
    if (!fav || !fav.url) continue;
    const title = fav.title || "";
    if ((fav.url + " " + title).toLowerCase().indexOf(q) === -1) continue;
    const key = normalizeUrl(fav.url);
    if (seen.has(key)) continue; // the history row for the same page wins
    seen.add(key);
    items.push({
      label: title || key,
      value: fav.url,
      kind: "fav",
      title,
      display: key,
    });
  }
  return items;
}

// Phase-2 merge: append search suggestions up to totalLimit. `toTarget` is
// the view's suggestionTarget, so a domain-like suggestion dedupes against a
// history/favorite row pointing at the same page.
function appendSearchSuggestions(items, list, toTarget, totalLimit) {
  const seen = new Set(items.map((i) => normalizeUrl(i.value)));
  const out = items.slice();
  for (const s of list || []) {
    if (out.length >= totalLimit) break;
    const target = toTarget(s);
    if (!target) continue;
    const key = normalizeUrl(target);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label: s, value: target, kind: "search" });
  }
  return out;
}

// ---------------------------------------------------------- typed-URL signal

// Deliberate navigations only (Enter on a URL-ish value, suggestion pick).
// Searches and internal pages no-op, so callers can invoke unconditionally.
function recordTypedUrl(url) {
  const js = bpjs();
  if (!js || !url) return;
  const u = String(url);
  if (isSearchUrl(u) || !isSuggestibleUri(u)) return;
  const key = normalizeUrl(u);
  if (!key) return;
  const map = js.get(TYPED_KEY) || {}; // mutate-then-set, same as addHistory
  const rec = map[key] || { n: 0, last: 0 };
  rec.n = (rec.n || 0) + 1;
  rec.last = Date.now();
  map[key] = rec;
  const keys = Object.keys(map);
  if (keys.length > TYPED_CAP) {
    keys
      .sort((a, b) => (map[a].last || 0) - (map[b].last || 0))
      .slice(0, keys.length - TYPED_CAP)
      .forEach((k) => delete map[k]);
  }
  js.set(TYPED_KEY, map);
  invalidate();
}

// -------------------------------------------- DuckDuckGo search suggestions

// Host-renderer twin of bp-client.js `suggest`: Node https (no CORS in play),
// OpenSearch `[term, [suggestions]]` response, and it ALWAYS resolves —
// failure just means "no search suggestions", the dropdown keeps its history
// and favorite rows. Out-of-order replies are dropped by jquery-ui's
// requestIndex guard, not here.
function fetchSearchSuggestions(term) {
  return new Promise((resolve) => {
    try {
      const req = https.get(
        {
          hostname: "ac.duckduckgo.com",
          path: "/ac/?type=list&q=" + encodeURIComponent(term),
          headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
        },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            try {
              const data = JSON.parse(body);
              resolve(Array.isArray(data && data[1]) ? data[1] : []);
            } catch (e) {
              resolve([]);
            }
          });
        }
      );
      req.on("error", () => resolve([]));
      req.setTimeout(4000, () => {
        req.destroy();
        resolve([]);
      });
    } catch (e) {
      resolve([]);
    }
  });
}

// -------------------------------------------------------------- row rendering

// Row icons are INLINE SVGs so `currentColor` follows the anchor's themed
// text color — the dropdown lives on <body>, outside the theme-scoped
// workspace element, where the toolbar's <img>-based icons wouldn't recolor.
// History and favorite rows reuse the same Phosphor files as the toolbar;
// search rows use the find bar's magnifier.
const readIcon = (name) => {
  try {
    return fs.readFileSync(
      path.join(__dirname, "..", "resources", "icons", name + ".svg"),
      "utf8"
    );
  } catch (e) {
    return "";
  }
};
const ICONS = {
  history: readIcon("clock-counter-clockwise"),
  fav: readIcon("star"),
  search:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" ' +
    'stroke="currentColor" stroke-width="1.6" stroke-linecap="round">' +
    '<circle cx="6.75" cy="6.75" r="4.75"></circle>' +
    '<line x1="10.4" y1="10.4" x2="14" y2="14"></line></svg>',
};

// _renderItem body for the URL-bar widget. jquery-ui 1.10's menu only treats
// <li><a>…</a></li> as selectable items (an anchor-less <li> becomes a
// divider), and menu.refresh adds ui-menu-item/ui-corner-all itself. Titles
// are untrusted page content — inserted with .text().
function renderItem(jQ, ul, item) {
  const kind = item.kind || "search";
  const a = jQ("<a>").addClass("tb-suggestion tb-suggestion-" + kind);
  a.append(
    jQ("<span>")
      .addClass("tb-suggestion-icon")
      .html(ICONS[kind] || ICONS.search)
  );
  a.append(
    jQ("<span>")
      .addClass("tb-suggestion-title")
      .text(item.title || item.label || item.value)
  );
  if ((kind === "history" || kind === "fav") && item.display) {
    a.append(jQ("<span>").addClass("tb-suggestion-url").text(item.display));
  }
  return jQ("<li>").append(a).appendTo(ul);
}

module.exports = {
  localSuggestions,
  appendSearchSuggestions,
  fetchSearchSuggestions,
  recordTypedUrl,
  invalidate,
  renderItem,
  normalizeUrl,
  isSearchUrl,
  historySuggestions,
};
