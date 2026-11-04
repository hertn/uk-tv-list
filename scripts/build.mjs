// Builds the Stremio catalog files from TMDB: UK-made shows that are streaming on each UK service right now.
// Needs the env var TMDB_TOKEN (a TMDB "API Read Access Token"). Run: node scripts/build.mjs
import fs from 'node:fs';
import path from 'node:path';

const TOKEN = process.env.TMDB_TOKEN;
if (!TOKEN) { console.error('Set TMDB_TOKEN to your TMDB API Read Access Token'); process.exit(1); }
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PAGE = 100;                    // shows per Stremio page
const MIN_VOTES = 20;                // drops obscure / one-off entries

// TMDB watch-provider ids for the UK (watch_region=GB)
const SERVICES = [
  { id: 'bbc',   name: 'BBC iPlayer',     providers: [38] },
  { id: 'itvx',  name: 'ITVX',            providers: [41, 2300] },
  { id: 'ch4',   name: 'Channel 4',       providers: [103] },
  { id: 'uktv',  name: 'Dave / UKTV',     providers: [137] },
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

const manifestCatalogs = [], allGenres = new Set(), report = [];
for (const svc of SERVICES) {
  const found = new Map();
  const base = `/discover/tv?watch_region=GB&with_watch_providers=${svc.providers.join('|')}&with_origin_country=GB&sort_by=popularity.desc&vote_count.gte=${MIN_VOTES}&language=en-GB`;
  const first = await api(base + '&page=1');
  const pages = Math.min(first.total_pages, 40);
  const rest = await pool(Array.from({ length: pages - 1 }, (_, i) => i + 2), 4, (p) => api(base + '&page=' + p));
  for (const pg of [first, ...rest]) for (const s of pg.results) if (!found.has(s.id)) found.set(s.id, s);
  const list = [...found.values()];
  await pool(list, 8, async (s) => { s.imdb = await imdbOf(s.id); });
  // newest episode first: shows still on air come before ones that ended long ago (TMDB cannot sort discover by this, so look each one up)
  await pool(list, 8, async (s) => {
    const d = await api(`/tv/${s.id}?language=en-GB`);
    s.latest = [d.last_episode_to_air?.air_date, d.last_air_date, d.first_air_date].filter(Boolean).sort().pop() || '';
  });
  list.sort((a, b) => (b.latest || '').localeCompare(a.latest || '') || b.popularity - a.popularity);
  const shows = list.filter((s) => s.imdb).map((s) => ({
    meta: { id: s.imdb, type: 'series', name: s.name, releaseInfo: (s.first_air_date || '').slice(0, 4), poster: `https://images.metahub.space/poster/medium/${s.imdb}/img` },
    genres: [...new Set((s.genre_ids || []).map((g) => CATEGORY[g]).filter(Boolean))],
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
const manifest = {
  id: 'com.hertn.uktv', version: '1.0.0', name: "Hert's UK TV",
  description: 'UK-made shows streaming right now on BBC iPlayer, ITVX, Channel 4 and Dave / UKTV, sorted by genre, newest episodes first. Updated weekly.',
  resources: ['catalog'], types: ['series'], catalogs: manifestCatalogs, idPrefixes: ['tt'],
  logo: 'https://hertn.github.io/uk-tv-list/icon.svg', background: undefined,
};
fs.writeFileSync(path.join(ROOT, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log(report.join('\n'));
