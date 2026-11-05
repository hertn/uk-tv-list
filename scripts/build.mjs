// Builds the Stremio catalog files from TMDB: UK-made shows that are streaming on each UK service right now.
// Needs the env var TMDB_TOKEN (a TMDB "API Read Access Token"). Run: node scripts/build.mjs
import fs from 'node:fs';
import path from 'node:path';

const TOKEN = process.env.TMDB_TOKEN;
if (!TOKEN) { console.error('Set TMDB_TOKEN to your TMDB API Read Access Token'); process.exit(1); }
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PAGE = 2000;                   // shows per Stremio page: big, so a whole catalog loads at once and the browser search (Cmd-F) can find everything
const MIN_VOTES = 20;                // drops obscure / one-off entries

// TMDB watch-provider ids for the UK (watch_region=GB)
const SERVICES = [
  { id: 'bbc',   name: 'BBC iPlayer',     providers: [38],       network: /^(BBC|CBBC|CBeebies)/i },
  { id: 'itvx',  name: 'ITVX',            providers: [41, 2300], network: /^(ITV|CITV|STV|UTV)/i },
  { id: 'ch4',   name: 'Channel 4',       providers: [103],      network: /^(Channel 4|E4|More4|Film4|4seven|All 4|4Music)/i },
  { id: 'udave', name: 'U&Dave',     providers: [137],      network: /^(Dave|U&|U ?(Dave|Gold|Yesterday|Drama|W|Alibi|Eden)|UKTV|Gold|Yesterday|Drama|W$|Alibi|Eden|Really)/i },
];
// TMDB TV genre id -> our friendlier category
const CATEGORY = {
  80: 'Crime & Mystery', 9648: 'Crime & Mystery',
  18: 'Drama', 35: 'Comedy', 10766: 'Soaps',
  10765: 'Sci-Fi & Fantasy', 99: 'Documentary',
  10764: 'Reality & Lifestyle', 10767: 'Talk & Panel',
  10762: 'Kids & Animation', 16: 'Kids & Animation',
  10759: 'Action & Adventure', 10768: 'War & History',
};

const api = async (url, tries = 4) => {
  for (let i = 0; i < tries; i++) {
    const r = await fetch('https://api.themoviedb.org/3' + url, { headers: { Authorization: 'Bearer ' + TOKEN, accept: 'application/json' } });
    if (r.ok) return r.json();
    if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 1000 * (i + 1))); continue; }
    throw new Error(`TMDB ${r.status} for ${url.replace(/\?.*/, '')}`);
  }
  throw new Error('TMDB kept failing: ' + url);
};
const pool = async (items, n, fn) => { const out = []; let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } })); return out; };

// TMDB id -> IMDb id, kept between runs so a weekly update only looks up new shows
const cacheFile = path.join(ROOT, 'data/imdb-cache.json');
const cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {};
const imdbOf = async (tmdbId) => {
  if (tmdbId in cache) return cache[tmdbId];
  const d = await api(`/tv/${tmdbId}/external_ids`);
  return (cache[tmdbId] = d.imdb_id || null);
};

const write = (rel, obj) => { const f = path.join(ROOT, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(obj)); };
fs.rmSync(path.join(ROOT, 'catalog'), { recursive: true, force: true });

// ---- Sources -------------------------------------------------------------------------------------------------------------------
// BBC iPlayer, Channel 4 and U&Dave: read each platform's own A-Z / all-shows pages, so the list matches what the website shows.
// ITVX: itv.com blocks scripts (bot protection), so it still comes from TMDB's UK provider data.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const page = async (url, tries = 3) => {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'en-GB' } }); if (r.ok) return r.text(); } catch {}
    await new Promise((s) => setTimeout(s, 1000 * (i + 1)));
  }
  return null;
};
const unesc = (t) => t.replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

async function scrapeBBC() {
  const titles = new Set();
  for (const letter of ['0-9', ...'abcdefghijklmnopqrstuvwxyz']) {
    for (let pg = 1, total = 1; pg <= total; pg++) {
      const html = await page(`https://www.bbc.co.uk/iplayer/a-z/${letter}?page=${pg}`);
      const m = html && html.match(/__IPLAYER_REDUX_STATE__\s*=\s*(\{.*?\});\s*<\/script>/s);
      if (!m) break;
      const st = JSON.parse(m[1]); total = st.pagination?.totalPages || 1;
      for (const e of st.programmes?.[letter]?.entities || []) if (e.props?.title) titles.add(e.props.title);
    }
  }
  return [...titles];
}
async function scrapeC4() {
  const titles = new Set();
  for (let off = 0; off < 6000; off += 60) {
    const html = await page('https://www.channel4.com/categories?offset=' + off);
    if (!html) break;
    let n = 0;
    for (const m of html.matchAll(/"labelText":"((?:[^"\\]|\\.)*)","altText":"[^"]*","hrefLink":"https:[^"]*?programmes(?:\\u002F|\/)/g)) { titles.add(JSON.parse('"' + m[1] + '"')); n++; }
    if (!n) break;
  }
  return [...titles].filter((t) => !/\((signed|audio described)\)/i.test(t));
}
async function scrapeU() {
  const titles = new Set();
  for (const letter of ['0-9', ...'abcdefghijklmnopqrstuvwxyz']) {
    const html = await page('https://u.co.uk/a-z/' + letter);
    if (!html) continue;
    for (const m of html.matchAll(/href="\/shows\/[^"\/]+\/watch-online">([^<]+)</g)) titles.add(unesc(m[1]));
  }
  return [...titles];
}

// title -> TMDB show (exact name match, most popular wins, UK-made preferred); remembered between runs
const titleFile = path.join(ROOT, 'data/title-cache-gb.json');
const titleCache = fs.existsSync(titleFile) ? JSON.parse(fs.readFileSync(titleFile, 'utf8')) : {};
const norm = (t) => t.toLowerCase().replace(/&/g, 'and').replace(/^the /, '').replace(/[^a-z0-9]+/g, ' ').trim();
const resolveTitle = async (title) => {
  if (title in titleCache) return titleCache[title];
  const d = await api(`/search/tv?query=${encodeURIComponent(title)}&language=en-GB&include_adult=false`);
  // UK-made only (American imports that the platforms carry are left out on purpose)
  const hits = d.results.filter((r) => r.origin_country.includes('GB') && (norm(r.name) === norm(title) || norm(r.original_name) === norm(title)));
  hits.sort((a, b) => b.popularity - a.popularity);
  const h = hits[0];
  return (titleCache[title] = h ? { id: h.id, name: h.name, first_air_date: h.first_air_date, genre_ids: h.genre_ids, popularity: h.popularity } : null);
};

async function viaTMDB(svc) {
  const base = `/discover/tv?watch_region=GB&with_watch_providers=${svc.providers.join('|')}&with_origin_country=GB&sort_by=popularity.desc&vote_count.gte=1&language=en-GB`;
  const first = await api(base + '&page=1');
  const pages = Math.min(first.total_pages, 40);
  const rest = await pool(Array.from({ length: pages - 1 }, (_, i) => i + 2), 4, (p) => api(base + '&page=' + p));
  const found = new Map();
  for (const pg of [first, ...rest]) for (const r of pg.results) found.set(r.id, r);
  const list = [...found.values()];
  return list;                                             // ITVX: TMDB's UK provider list as it is
}

// Shows a service carries but its data source leaves out; added by title (still checked as UK-made, resolved through TMDB).
const EXTRAS = { itvx: ['Coronation Street'] };

const sources = { bbc: scrapeBBC, ch4: scrapeC4, udave: scrapeU };
const perService = {};
for (const svc of SERVICES) {
  let shows;
  if (sources[svc.id]) {
    const titles = await sources[svc.id]();
    console.log(`${svc.name}: ${titles.length} titles on the website`);
    if (titles.length < 50) throw new Error(`${svc.name}: only ${titles.length} titles scraped, the site layout probably changed`);
    const hits = await pool(titles, 8, resolveTitle);
    const byId = new Map(); hits.filter(Boolean).forEach((h) => byId.set(h.id, h));
    shows = [...byId.values()];
    console.log(`${svc.name}: ${shows.length} matched to TMDB; unmatched e.g. ${titles.filter((t, i) => !hits[i]).slice(0, 8).join(' | ')}`);
  } else shows = await viaTMDB(svc);
  for (const t of EXTRAS[svc.id] || []) {
    const h = await resolveTitle(t);
    if (h && !shows.some((x) => x.id === h.id)) shows.push(h); else if (!h) console.log(`EXTRAS: could not find "${t}" on TMDB`);
  }
  perService[svc.id] = shows;
}
fs.writeFileSync(titleFile, JSON.stringify(titleCache));
const canon = new Map();                                    // one object per show, shared by every service it is on
for (const id of Object.keys(perService)) perService[id] = perService[id].map((s) => { if (!canon.has(s.id)) canon.set(s.id, s); return canon.get(s.id); });
const everything = [...canon.values()];
await pool(everything, 8, async (s) => { s.imdb = await imdbOf(s.id); });
// newest episode first: shows still on air come before ones that ended long ago
await pool(everything, 8, async (s) => {
  const d = await api(`/tv/${s.id}?language=en-GB`);
  s.latest = [d.last_episode_to_air?.air_date, d.last_air_date, d.first_air_date].filter(Boolean).sort().pop() || '';
});

// TMDB tags many shows with several genres (Jonathan Creek: Comedy + Crime + Drama). Keep the most specific ones so a detective show
// is not listed under Comedy: Drama is only used when nothing else fits, and Comedy steps aside for Crime & Mystery.
const tidyGenres = (g) => {
  if (g.includes('Crime & Mystery')) g = g.filter((x) => x !== 'Comedy');
  if (g.length > 1) g = g.filter((x) => x !== 'Drama');
  return g;
};

const manifestCatalogs = [], allGenres = new Set(), report = [];
for (const svc of SERVICES) {
  const list = perService[svc.id];
  list.sort((a, b) => (b.latest || '').localeCompare(a.latest || '') || b.popularity - a.popularity);
  const shows = list.filter((s) => s.imdb).map((s) => ({
    meta: { id: s.imdb, type: 'series', name: s.name, releaseInfo: (s.first_air_date || '').slice(0, 4), poster: `https://images.metahub.space/poster/medium/${s.imdb}/img` },
    genres: tidyGenres([...new Set((s.genre_ids || []).map((g) => CATEGORY[g]).filter(Boolean))]),
  }));
  const genres = Object.values(CATEGORY).filter((g, i, a) => a.indexOf(g) === i).filter((g) => shows.some((s) => s.genres.includes(g)));
  genres.forEach((g) => allGenres.add(g));
  const emit = (name, items) => {                          // one file per page: Stremio asks for ...&skip=100
    const metas = items.map((s) => s.meta);
    for (let skip = 0; skip === 0 || skip < metas.length; skip += PAGE) {
      const part = name ? [name] : []; if (skip) part.push('skip=' + skip);
      write(`catalog/series/${svc.id}${part.length ? '/' + part.join('&') : ''}.json`, { metas: metas.slice(skip, skip + PAGE) });
    }
  };
  emit('', shows);
  for (const g of genres) emit('genre=' + g, shows.filter((s) => s.genres.includes(g)));
  // Stremio also requests /catalog/series/<id>.json for the plain list
  write(`catalog/series/${svc.id}.json`, { metas: shows.slice(0, PAGE).map((s) => s.meta) });
  manifestCatalogs.push({ type: 'series', id: svc.id, name: svc.name, extra: [{ name: 'genre', options: genres, isRequired: false }, { name: 'skip', isRequired: false }], genres, extraSupported: ['genre', 'skip'] });
  report.push(`${svc.name}: ${shows.length} shows (${list.length - shows.length} without an IMDb id skipped)`);
}
fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 0));
// 1.2.x: the patch number goes up by one on every build, so Stremio never keeps serving a cached manifest
const nextVersion = () => {
  try { const [a, b, c] = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version.split('.').map(Number); if (a === 1 && b === 2) return `1.2.${c + 1}`; } catch {}
  return '1.2.1';
};
const manifest = {
  id: 'com.hertn.uktv', version: nextVersion(), name: "Hert's UK TV",
  description: 'UK-made shows streaming right now on BBC iPlayer, ITVX, Channel 4 and U&Dave, sorted by genre, newest episodes first. Updated weekly (last build ' + new Date().toISOString().slice(0, 10) + ').',
  resources: ['catalog'], types: ['series'], catalogs: manifestCatalogs, idPrefixes: ['tt'],
  logo: 'https://hertn.github.io/uk-tv-list/icon.svg', background: undefined,
};
fs.writeFileSync(path.join(ROOT, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log(report.join('\n'));
