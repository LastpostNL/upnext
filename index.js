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

let TRAKT_REFRESH_TOKEN = process.env.TRAKT_REFRESH_TOKEN || null;
let TRAKT_ACCESS_TOKEN = null;

const REFRESH_TOKEN_FILE = path.join(__dirname, 'trakt_refresh_token.txt');

if (!TRAKT_REFRESH_TOKEN && fs.existsSync(REFRESH_TOKEN_FILE)) {
  TRAKT_REFRESH_TOKEN = fs.readFileSync(REFRESH_TOKEN_FILE, 'utf-8').trim();
}

/**
 * -----------------------------
 * CACHE LAYERS (IMPORTANT)
 * -----------------------------
 */

// full catalog cache
let catalogCache = null;
let catalogCacheTs = 0;
const CATALOG_TTL = 5 * 60 * 1000; // 5 min

// per-show cache (VERY IMPORTANT OPTIMIZATION)
const showCache = new Map();
const showCacheTTL = 30 * 60 * 1000; // 30 min

// concurrency limit
const MAX_CONCURRENCY = 3;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * -----------------------------
 * AUTH (REFRESH ONLY)
 * -----------------------------
 */

async function refreshAccessToken() {
  if (!TRAKT_CLIENT_ID || !TRAKT_CLIENT_SECRET || !TRAKT_REFRESH_TOKEN) {
    console.log('Missing Trakt credentials');
    return null;
  }

  const res = await fetch('https://api.trakt.tv/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: TRAKT_REFRESH_TOKEN,
      client_id: TRAKT_CLIENT_ID,
      client_secret: TRAKT_CLIENT_SECRET,
      grant_type: 'refresh_token'
    }).toString()
  });

  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    console.log('Trakt refresh raw:', text);
    return null;
  }

  if (!res.ok) {
    console.error('Refresh failed:', data);
    return null;
  }

  TRAKT_ACCESS_TOKEN = data.access_token;
  TRAKT_REFRESH_TOKEN = data.refresh_token;

  if (!process.env.TRAKT_REFRESH_TOKEN) {
    fs.writeFileSync(REFRESH_TOKEN_FILE, TRAKT_REFRESH_TOKEN);
  }

  console.log('Token refreshed');
  return TRAKT_ACCESS_TOKEN;
}

async function ensureToken() {
  if (TRAKT_ACCESS_TOKEN) return TRAKT_ACCESS_TOKEN;
  return await refreshAccessToken();
}

/**
 * -----------------------------
 * TRAKT API WRAPPER
 * -----------------------------
 */

async function traktGet(url) {
  const token = await ensureToken();

  const res = await fetch(`https://api.trakt.tv${url}`, {
    headers: {
      'trakt-api-version': '2',
      'trakt-api-key': TRAKT_CLIENT_ID,
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }
  });

  if (res.status === 401) {
    await refreshAccessToken();
    return traktGet(url);
  }

  if (!res.ok) {
    throw new Error(await res.text());
  }

  return res.json();
}

/**
 * -----------------------------
 * USER SHOWS
 * -----------------------------
 */

async function fetchUserShows() {
  const [collected, watched] = await Promise.all([
    traktGet('/sync/collection/shows?extended=full,images'),
    traktGet('/sync/watched/shows?extended=full,images')
  ]);

  const map = new Map();

  for (const item of [...(collected || []), ...(watched || [])]) {
    const show = item.show;
    if (!show?.ids?.trakt) continue;
    map.set(show.ids.trakt, show);
  }

  return [...map.values()];
}

/**
 * -----------------------------
 * EPISODE CACHE PER SHOW
 * -----------------------------
 */

async function getLatestEpisode(traktId) {
  const cached = showCache.get(traktId);
  if (cached && Date.now() - cached.ts < showCacheTTL) {
    return cached.data;
  }

  const seasons = await traktGet(`/shows/${traktId}/seasons?extended=episodes`);

  const now = Date.now();
  const cutoff = now - 365 * 24 * 60 * 60 * 1000;

  let last = null;

  for (const season of seasons || []) {
    if (!season.episodes || season.number === 0) continue;

    for (const ep of season.episodes) {
      if (!ep?.first_aired) continue;

      const ts = Date.parse(ep.first_aired);
      if (isNaN(ts) || ts > now || ts < cutoff) continue;

      if (!last || ts > last.ts) {
        last = {
          season: ep.season,
          number: ep.number,
          title: ep.title,
          first_aired: ep.first_aired,
          ts
        };
      }
    }
  }

  showCache.set(traktId, { ts: Date.now(), data: last });

  return last;
}

/**
 * -----------------------------
 * CONCURRENCY
 * -----------------------------
 */

async function mapLimit(arr, limit, fn) {
  const res = [];
  let i = 0;

  const workers = new Array(limit).fill(null).map(async () => {
    while (i < arr.length) {
      const idx = i++;
      res[idx] = await fn(arr[idx], idx);
    }
  });

  await Promise.all(workers);
  return res;
}

/**
 * -----------------------------
 * CATALOG BUILDER
 * -----------------------------
 */

async function buildCatalog() {
  if (catalogCache && Date.now() - catalogCacheTs < CATALOG_TTL) {
    return catalogCache;
  }

  const shows = await fetchUserShows();

  const enriched = await mapLimit(
    shows,
    MAX_CONCURRENCY,
    async show => {
      const latest = await getLatestEpisode(show.ids.trakt);
      if (!latest) return null;

      return {
        show,
        latest
      };
    }
  );

  const metas = enriched
    .filter(Boolean)
    .map(({ show, latest }) => ({
      id: `tmdb:${show.ids.tmdb}`,
      type: 'series',
      name: show.title || show.name,
      overview: show.overview,
      poster: show?.images?.poster?.[0]
        ? `https://${show.images.poster[0]}`
        : null,
      ids: { tmdb: show.ids.tmdb },
      extra: { latestEpisode: latest },
      description: `S${latest.season}E${latest.number} - ${latest.title}`
    }))
    .sort((a, b) => {
      const aT = a.extra.latestEpisode.ts;
      const bT = b.extra.latestEpisode.ts;
      return bT - aT;
    });

  catalogCache = { metas };
  catalogCacheTs = Date.now();

  return catalogCache;
}

/**
 * -----------------------------
 * ROUTES
 * -----------------------------
 */

app.get('/manifest.json', (req, res) => {
  res.json({
    id: 'org.trakt.pro.latest',
    version: '2.0.0',
    name: 'Trakt Latest PRO',
    resources: ['catalog', 'meta'],
    types: ['series'],
    catalogs: [
      {
        id: 'trakt-latest',
        type: 'series',
        name: 'Latest Episodes (PRO)'
      }
    ]
  });
});

app.get('/catalog/:id', async (req, res) => {
  if (req.params.id !== 'trakt-latest') {
    return res.json({ metas: [] });
  }

  try {
    const cat = await buildCatalog();
    res.json(cat);
  } catch (e) {
    console.error(e);
    res.status(500).json({ metas: [] });
  }
});

app.get('/', (req, res) => {
  res.send('Trakt PRO addon running');
});

/**
 * -----------------------------
 * STARTUP
 * -----------------------------
 */

(async () => {
  if (TRAKT_REFRESH_TOKEN) {
    await refreshAccessToken();
  }

  app.listen(PORT, () => {
    console.log(`Running on ${PORT}`);
  });
})();
