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

let catalogCache = null;
let catalogCacheTs = 0;
const CACHE_TTL_SECONDS = parseInt(process.env.CACHE_TTL_SECONDS || '300', 10);

const MAX_CONCURRENT_SEASON_REQUESTS = 2;

const wait = ms => new Promise(r => setTimeout(r, ms));

function getRedirectUri(req) {
  if (TRAKT_REDIRECT_URI_ENV) return TRAKT_REDIRECT_URI_ENV;
  return `${req.protocol}://${req.get('host')}/auth/callback`;
}

// -------------------- TOKEN REFRESH --------------------

async function refreshAccessToken() {
  if (!TRAKT_CLIENT_ID || !TRAKT_CLIENT_SECRET || !TRAKT_REFRESH_TOKEN) {
    console.log('Missing Trakt credentials for refresh');
    return null;
  }

  const url = 'https://api.trakt.tv/oauth/token';

  const params = new URLSearchParams({
    refresh_token: TRAKT_REFRESH_TOKEN,
    client_id: TRAKT_CLIENT_ID,
    client_secret: TRAKT_CLIENT_SECRET,
    redirect_uri: TRAKT_REDIRECT_URI_ENV || 'urn:ietf:wg:oauth:2.0:oob',
    grant_type: 'refresh_token'
  });

  const res = await fetch(url, {
    method: 'POST',
    body: params.toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });

  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    console.error('Refresh failed:', data);
    return null;
  }

  TRAKT_ACCESS_TOKEN = data.access_token;
  TRAKT_REFRESH_TOKEN = data.refresh_token;

  if (!process.env.TRAKT_REFRESH_TOKEN) {
    fs.writeFileSync(REFRESH_TOKEN_FILE, TRAKT_REFRESH_TOKEN, 'utf-8');
  }

  return TRAKT_ACCESS_TOKEN;
}

async function ensureAccessToken() {
  if (TRAKT_ACCESS_TOKEN) return TRAKT_ACCESS_TOKEN;
  if (TRAKT_REFRESH_TOKEN) return await refreshAccessToken();
  return null;
}

// -------------------- TRAKT GET --------------------

async function traktGet(path) {
  const token = await ensureAccessToken();

  const headers = {
    'trakt-api-version': '2',
    'trakt-api-key': TRAKT_CLIENT_ID
  };

  if (token) headers.Authorization = `Bearer ${token}`;

  const url = `https://api.trakt.tv${path}`;
  const res = await fetch(url, { headers });

  if (res.status === 401 && TRAKT_REFRESH_TOKEN) {
    await refreshAccessToken();

    const retry = await fetch(url, {
      headers: {
        ...headers,
        Authorization: `Bearer ${TRAKT_ACCESS_TOKEN}`
      }
    });

    if (!retry.ok) throw new Error(await retry.text());
    return retry.json();
  }

  if (!res.ok) {
    throw new Error(await res.text());
  }

  return res.json();
}

// -------------------- USER SHOWS --------------------

async function fetchUserShows() {
  const collected = await traktGet('/sync/collection/shows?extended=full,images');
  const watched = await traktGet('/sync/watched/shows?extended=full,images');

  const map = new Map();

  for (const it of collected || []) {
    const show = it.show;
    if (show?.ids?.trakt) map.set(show.ids.trakt, show);
  }

  for (const it of watched || []) {
    const show = it.show;
    if (show?.ids?.trakt) map.set(show.ids.trakt, show);
  }

  return Array.from(map.values());
}

// -------------------- LATEST EPISODE --------------------

async function fetchLatestAvailableEpisodeForShow(traktId) {
  try {
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

    return last;
  } catch (e) {
    return null;
  }
}

// -------------------- CONCURRENCY --------------------

async function mapWithConcurrencyLimit(items, limit, fn) {
  const results = [];
  let i = 0;
  const executing = new Set();

  async function enqueue() {
    if (i >= items.length) return;

    const idx = i++;
    const p = Promise.resolve().then(() => fn(items[idx], idx));

    results[idx] = p;
    executing.add(p);

    p.finally(() => executing.delete(p));

    if (executing.size >= limit) {
      await Promise.race(executing);
    }

    return enqueue();
  }

  await enqueue();
  return Promise.all(results);
}

// -------------------- CATALOG --------------------

async function buildCatalog() {
  if (catalogCache && (Date.now() - catalogCacheTs) / 1000 < CACHE_TTL_SECONDS) {
    return catalogCache;
  }

  const shows = await fetchUserShows();

  const jobs = shows.map(show => ({
    show,
    traktId: show.ids?.trakt
  }));

  const resolved = await mapWithConcurrencyLimit(
    jobs,
    MAX_CONCURRENT_SEASON_REQUESTS,
    async job => {
      if (!job.traktId) return null;

      const latest = await fetchLatestAvailableEpisodeForShow(job.traktId);
      if (!latest) return null;

      return { show: job.show, latest };
    }
  );

  const metas = resolved
    .filter(Boolean)
    .map(({ show, latest }) => ({
      id: `tmdb:${show.ids.tmdb}`,
      type: 'series',
      name: show.title || show.name,
      ids: { tmdb: show.ids.tmdb },
      overview: show.overview,
      poster: show?.images?.poster?.[0]
        ? `https://${show.images.poster[0]}`
        : null,
      extra: {
        latestEpisode: latest
      },
      description: `Laatst: S${latest.season}E${latest.number} - ${latest.title}`
    }));

  const catalog = { metas };

  catalogCache = catalog;
  catalogCacheTs = Date.now();

  return catalog;
}

// -------------------- ROUTES --------------------

app.get('/manifest.json', (req, res) => {
  res.json({
    id: 'org.lastpostnl.trakt-latest-addon',
    version: '1.0.0',
    name: 'Trakt Latest Episode',
    resources: ['catalog', 'meta'],
    types: ['series'],
    catalogs: [
      {
        id: 'trakt-latest',
        type: 'series',
        name: 'Trakt Latest'
      }
    ]
  });
});

app.get(['/catalog/:id'], async (req, res) => {
  if (req.params.id !== 'trakt-latest') return res.json({ metas: [] });

  const cat = await buildCatalog();
  res.json(cat);
});

app.get('/auth', (req, res) => {
  const redirectUri = getRedirectUri(req);

  const url =
    `https://trakt.tv/oauth/authorize?response_type=code` +
    `&client_id=${TRAKT_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;

  res.redirect(url);
});

// -------------------- FIXED CALLBACK --------------------

app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  const redirectUri = getRedirectUri(req);

  const params = new URLSearchParams({
    code,
    client_id: TRAKT_CLIENT_ID,
    client_secret: TRAKT_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
  });

  const r = await fetch('https://api.trakt.tv/oauth/token', {
    method: 'POST',
    body: params.toString(),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  });

  const text = await r.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  console.log('TOKEN STATUS:', r.status);
  console.log('TOKEN RESPONSE:', data);

  if (!r.ok) {
    return res.status(500).send(`Token exchange failed: ${text}`);
  }

  TRAKT_ACCESS_TOKEN = data.access_token;
  TRAKT_REFRESH_TOKEN = data.refresh_token;

  res.send(`
    <h2>Success</h2>
    <p>Tokens ontvangen</p>
  `);
});

app.get('/', (req, res) => {
  res.send('Addon running');
});

// -------------------- START --------------------

app.listen(PORT, () => {
  console.log('Server running on', PORT);
});
