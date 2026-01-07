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

// Concurrency
const MAX_CONCURRENT_REQUESTS = 2;

/* =========================
   OAuth helpers
========================= */

function getRedirectUri(req) {
  if (TRAKT_REDIRECT_URI_ENV) return TRAKT_REDIRECT_URI_ENV;
  return `${req.protocol}://${req.get('host')}/auth/callback`;
}

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
  if (!res.ok) throw new Error('Failed to refresh token');

  TRAKT_ACCESS_TOKEN = data.access_token;
  TRAKT_REFRESH_TOKEN = data.refresh_token;

  if (!process.env.TRAKT_REFRESH_TOKEN) {
    fs.writeFileSync(REFRESH_TOKEN_FILE, TRAKT_REFRESH_TOKEN);
  }

  return TRAKT_ACCESS_TOKEN;
}

async function ensureAccessToken() {
  if (TRAKT_ACCESS_TOKEN) return TRAKT_ACCESS_TOKEN;
  if (TRAKT_REFRESH_TOKEN) return refreshAccessToken();
  return null;
}

/* =========================
   Trakt API helper
========================= */

async function traktGet(path) {
  const token = await ensureAccessToken();

  const res = await fetch(`https://api.trakt.tv${path}`, {
    headers: {
      'trakt-api-version': '2',
      'trakt-api-key': TRAKT_CLIENT_ID,
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Trakt error ${res.status}: ${txt}`);
  }

  return res.json();
}

/* =========================
   Data fetchers
========================= */

// Collected + watched shows (uniek)
async function fetchUserShows() {
  const [collected, watched] = await Promise.all([
    traktGet('/sync/collection/shows?extended=full,images'),
    traktGet('/sync/watched/shows?extended=full,images')
  ]);

  const map = new Map();
  for (const it of [...collected, ...watched]) {
    const show = it.show;
    if (show?.ids?.trakt) {
      map.set(String(show.ids.trakt), show);
    }
  }
  return Array.from(map.values());
}

// Hidden / dropped shows
async function fetchHiddenShows() {
  const hidden = await traktGet('/users/hidden/progress_watched?type=show');
  const set = new Set();
  for (const it of hidden || []) {
    if (it.show?.ids?.trakt) {
      set.add(String(it.show.ids.trakt));
    }
  }
  return set;
}

// Progress per show
async function fetchShowProgress(traktId) {
  return traktGet(`/shows/${traktId}/progress/watched`);
}

// Latest aired episode (absolute, niet user-afhankelijk)
async function fetchLatestAiredEpisode(traktId) {
  const seasons = await traktGet(`/shows/${traktId}/seasons?extended=episodes`);
  const now = Date.now();
  let best = null;

  for (const s of seasons || []) {
    for (const ep of s.episodes || []) {
      if (!ep.first_aired) continue;
      const ts = Date.parse(ep.first_aired);
      if (!isNaN(ts) && ts <= now && (!best || ts > best.ts)) {
        best = {
          season: ep.season,
          number: ep.number,
          title: ep.title || '',
          first_aired: ep.first_aired,
          ts
        };
      }
    }
  }
  return best;
}

// Volledig bekeken? (specials tellen niet)
function isShowCompleted(progress) {
  if (!progress?.seasons) return false;
  return progress.seasons
    .filter(s => s.number !== 0)
    .every(s => s.completed >= s.aired);
}

/* =========================
   Concurrency helper
========================= */

async function mapLimited(items, limit, fn) {
  const ret = [];
  const executing = [];

  for (const item of items) {
    const p = Promise.resolve().then(() => fn(item));
    ret.push(p);

    if (limit <= items.length) {
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= limit) {
        await Promise.race(executing);
      }
    }
  }
  return Promise.all(ret);
}

/* =========================
   Catalog builder
========================= */

async function buildCatalog() {
  if (catalogCache && (Date.now() - catalogCacheTs) / 1000 < CACHE_TTL_SECONDS) {
    return catalogCache;
  }

  const [shows, hiddenSet] = await Promise.all([
    fetchUserShows(),
    fetchHiddenShows()
  ]);

  const items = await mapLimited(shows, MAX_CONCURRENT_REQUESTS, async show => {
    const traktId = show.ids?.trakt;
    if (!traktId) return null;
    if (hiddenSet.has(String(traktId))) return null;

    const progress = await fetchShowProgress(traktId);
    if (isShowCompleted(progress)) return null;

    const latest = await fetchLatestAiredEpisode(traktId);
    if (!latest) return null;

    return {
      show,
      latest
    };
  });

  const metas = items
    .filter(Boolean)
    .sort((a, b) => b.latest.ts - a.latest.ts)
    .map(({ show, latest }) => ({
      id: `tmdb:${show.ids.tmdb}`,
      type: 'series',
      name: show.title,
      ids: { tmdb: show.ids.tmdb },
      poster: show.images?.poster?.[0]
        ? `https://${show.images.poster[0]}`
        : null,
      description: `Laatst uitgezonden: S${latest.season}E${latest.number} — ${latest.title}`,
      extra: {
        latestEpisode: {
          season: latest.season,
          number: latest.number,
          first_aired: latest.first_aired
        }
      }
    }));

  catalogCache = { metas };
  catalogCacheTs = Date.now();
  return catalogCache;
}

/* =========================
   Stremio endpoints
========================= */

app.get('/manifest.json', (req, res) => {
  res.json({
    id: 'org.lastpostnl.trakt-recently-aired',
    version: '1.0.0',
    name: 'Trakt – Recently Aired',
    description: 'Unwatched shows ordered by most recently aired episode',
    resources: ['catalog'],
    types: ['series'],
    catalogs: [{ type: 'series', id: 'trakt-latest', name: 'Recently Aired' }]
  });
});

app.get(['/catalog/:type/:id.json'], async (req, res) => {
  if (req.params.id !== 'trakt-latest') return res.json({ metas: [] });
  try {
    res.json(await buildCatalog());
  } catch (e) {
    console.error(e);
    res.status(500).json({ metas: [] });
  }
});

app.get('/', (req, res) => {
  res.send('Addon running. Manifest at /manifest.json');
});

/* =========================
   Startup
========================= */

(async () => {
  if (TRAKT_REFRESH_TOKEN) await refreshAccessToken();
  app.listen(PORT, () => console.log(`Server running on ${PORT}`));
})();
