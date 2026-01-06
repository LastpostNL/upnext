const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());
app.set('trust proxy', true);

const PORT = process.env.PORT || 3000;

const TRAKT_CLIENT_ID = process.env.TRAKT_CLIENT_ID;
const TRAKT_CLIENT_SECRET = process.env.TRAKT_CLIENT_SECRET;
const TRAKT_REDIRECT_URI_ENV = process.env.TRAKT_REDIRECT_URI || null;

let TRAKT_REFRESH_TOKEN = process.env.TRAKT_REFRESH_TOKEN || null;
let TRAKT_ACCESS_TOKEN = process.env.TRAKT_ACCESS_TOKEN || null;

const REFRESH_TOKEN_FILE = path.join(__dirname, 'trakt_refresh_token.txt');
if (!TRAKT_REFRESH_TOKEN && fs.existsSync(REFRESH_TOKEN_FILE)) {
  TRAKT_REFRESH_TOKEN = fs.readFileSync(REFRESH_TOKEN_FILE, 'utf-8').trim();
}

// Cache
let catalogCache = null;
let catalogCacheTs = 0;
const CACHE_TTL_SECONDS = parseInt(process.env.CACHE_TTL_SECONDS || '300', 10);
const MAX_CONCURRENT_SEASON_REQUESTS = 2;

const wait = ms => new Promise(r => setTimeout(r, ms));

function getRedirectUri(req) {
  if (TRAKT_REDIRECT_URI_ENV) return TRAKT_REDIRECT_URI_ENV;
  return `${req.protocol}://${req.get('host')}/auth/callback`;
}

/* ===================== AUTH ===================== */

async function refreshAccessToken() {
  if (!TRAKT_CLIENT_ID || !TRAKT_CLIENT_SECRET || !TRAKT_REFRESH_TOKEN) return null;

  const res = await fetch('https://api.trakt.tv/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      refresh_token: TRAKT_REFRESH_TOKEN,
      client_id: TRAKT_CLIENT_ID,
      client_secret: TRAKT_CLIENT_SECRET,
      redirect_uri: TRAKT_REDIRECT_URI_ENV || 'urn:ietf:wg:oauth:2.0:oob',
      grant_type: 'refresh_token'
    })
  });

  const data = await res.json();
  if (!res.ok) return null;

  TRAKT_ACCESS_TOKEN = data.access_token;
  TRAKT_REFRESH_TOKEN = data.refresh_token;

  if (!process.env.TRAKT_REFRESH_TOKEN) {
    fs.writeFileSync(REFRESH_TOKEN_FILE, TRAKT_REFRESH_TOKEN, 'utf-8');
  }

  return TRAKT_ACCESS_TOKEN;
}

async function ensureAccessToken() {
  if (TRAKT_ACCESS_TOKEN) return TRAKT_ACCESS_TOKEN;
  if (TRAKT_REFRESH_TOKEN) return refreshAccessToken();
  return null;
}

async function traktGet(path) {
  const token = await ensureAccessToken();
  const headers = {
    'trakt-api-version': '2',
    'trakt-api-key': TRAKT_CLIENT_ID
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`https://api.trakt.tv${path}`, { headers });
  if (!res.ok) throw new Error(`Trakt API error ${res.status}: ${await res.text()}`);
  return res.json();
}

/* ===================== CORE LOGIC ===================== */

function isShowCompleted(seasons = []) {
  return seasons
    .filter(s => s.number > 0) // specials negeren
    .every(season =>
      season.episodes &&
      season.episodes.length > 0 &&
      season.episodes.every(ep => ep.completed)
    );
}

async function fetchUserShows() {
  const collected = await traktGet('/sync/collection/shows?extended=full,images');
  const watched = await traktGet('/sync/watched/shows?extended=full,images');

  const map = new Map();

  for (const it of collected || []) {
    if (!it.show?.ids?.trakt) continue;
    map.set(String(it.show.ids.trakt), {
      show: it.show,
      watchedSeasons: []
    });
  }

  for (const it of watched || []) {
    if (!it.show?.ids?.trakt) continue;
    const key = String(it.show.ids.trakt);

    if (!map.has(key)) {
      map.set(key, { show: it.show, watchedSeasons: it.seasons || [] });
    } else {
      map.get(key).watchedSeasons = it.seasons || [];
    }
  }

  return Array.from(map.values())
    .filter(s => !isShowCompleted(s.watchedSeasons));
}

async function fetchLatestAvailableEpisodeForShow(traktId) {
  const seasons = await traktGet(`/shows/${traktId}/seasons?extended=episodes`);
  const now = Date.now();
  let best = null;

  for (const season of seasons || []) {
    if (!season.episodes || season.number === 0) continue;
    for (const ep of season.episodes) {
      const ts = Date.parse(ep.first_aired);
      if (!isNaN(ts) && ts <= now && (!best || ts > best.ts)) {
        best = {
          ts,
          season: ep.season,
          number: ep.number,
          title: ep.title || '',
          first_aired: ep.first_aired
        };
      }
    }
  }
  return best;
}

async function mapWithConcurrencyLimit(items, limit, fn) {
  const results = [];
  const executing = new Set();
  let i = 0;

  async function enqueue() {
    if (i >= items.length) return;
    const idx = i++;
    const p = Promise.resolve(fn(items[idx]));
    results[idx] = p;
    executing.add(p);
    p.finally(() => executing.delete(p));
    if (executing.size >= limit) await Promise.race(executing);
    return enqueue();
  }

  await enqueue();
  return Promise.all(results);
}

/* ===================== CATALOG ===================== */

function getShowPoster(images) {
  if (!images) return null;
  const pick = arr => Array.isArray(arr) && arr[0] ? `https://${arr[0]}` : null;
  return pick(images.poster) || pick(images.thumb) || pick(images.fanart);
}

async function buildCatalog() {
  if (catalogCache && (Date.now() - catalogCacheTs) / 1000 < CACHE_TTL_SECONDS) {
    return catalogCache;
  }

  const shows = await fetchUserShows();

  const resolved = await mapWithConcurrencyLimit(
    shows,
    MAX_CONCURRENT_SEASON_REQUESTS,
    async s => ({
      show: s.show,
      latest: await fetchLatestAvailableEpisodeForShow(s.show.ids.trakt)
    })
  );

  const metas = resolved
    .filter(r => r.latest)
    .sort((a, b) => b.latest.ts - a.latest.ts)
    .map(r => ({
      id: `tmdb:${r.show.ids.tmdb}`,
      type: 'series',
      name: r.show.title,
      poster: getShowPoster(r.show.images),
      ids: { tmdb: r.show.ids.tmdb },
      overview: r.show.overview,
      description: `Laatst beschikbare aflevering: S${r.latest.season}E${r.latest.number} — ${r.latest.title}`
    }));

  catalogCache = { metas };
  catalogCacheTs = Date.now();
  return catalogCache;
}

/* ===================== ROUTES ===================== */

app.get('/manifest.json', (req, res) => {
  res.json({
    id: 'org.lastpostnl.trakt-latest-addon',
    version: '1.1.0',
    name: 'Trakt – Next Episodes',
    resources: ['catalog'],
    types: ['series'],
    catalogs: [{ type: 'series', id: 'trakt-latest', name: 'Trakt: verder kijken' }]
  });
});

app.get('/catalog/:type/:id.json', async (req, res) => {
  if (req.params.id !== 'trakt-latest') return res.json({ metas: [] });
  try {
    res.json(await buildCatalog());
  } catch {
    res.json({ metas: [] });
  }
});

app.listen(PORT, async () => {
  if (TRAKT_REFRESH_TOKEN) await refreshAccessToken();
  console.log(`Server running on ${PORT}`);
});
