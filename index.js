const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors()); // CORS toegevoegd

app.set('trust proxy', true);

const PORT = process.env.PORT || 3000;

const TRAKT_CLIENT_ID = process.env.TRAKT_CLIENT_ID;
const TRAKT_CLIENT_SECRET = process.env.TRAKT_CLIENT_SECRET;
const TRAKT_REDIRECT_URI_ENV = process.env.TRAKT_REDIRECT_URI || null;

let TRAKT_REFRESH_TOKEN = process.env.TRAKT_REFRESH_TOKEN || null;
let TRAKT_ACCESS_TOKEN = process.env.TRAKT_ACCESS_TOKEN || null;

// fallback bestand (alleen lokaal)
const REFRESH_TOKEN_FILE = path.join(__dirname, 'trakt_refresh_token.txt');
if (!TRAKT_REFRESH_TOKEN && fs.existsSync(REFRESH_TOKEN_FILE)) {
  TRAKT_REFRESH_TOKEN = fs.readFileSync(REFRESH_TOKEN_FILE, 'utf-8').trim();
}

// Cache
let catalogCache = null;
let catalogCacheTs = 0;
const CACHE_TTL_SECONDS = parseInt(process.env.CACHE_TTL_SECONDS || '300', 10);

// concurrency limit for season requests
const MAX_CONCURRENT_SEASON_REQUESTS = 2;

// Utility: sleep
const wait = ms => new Promise(r => setTimeout(r, ms));

// Helper to get the redirect URI to use
function getRedirectUri(req) {
  if (TRAKT_REDIRECT_URI_ENV) return TRAKT_REDIRECT_URI_ENV;
  return `${req.protocol}://${req.get('host')}/auth/callback`;
}

// Refresh access token using Trakt refresh token
async function refreshAccessToken() {
  if (!TRAKT_CLIENT_ID || !TRAKT_CLIENT_SECRET || !TRAKT_REFRESH_TOKEN) {
    console.log('Missing Trakt client id/secret or refresh token for token refresh.');
    return null;
  }

  const url = 'https://api.trakt.tv/oauth/token';
  const redirectUriForRefresh = TRAKT_REDIRECT_URI_ENV || 'urn:ietf:wg:oauth:2.0:oob';

  const body = {
    refresh_token: TRAKT_REFRESH_TOKEN,
    client_id: TRAKT_CLIENT_ID,
    client_secret: TRAKT_CLIENT_SECRET,
    redirect_uri: redirectUriForRefresh,
    grant_type: 'refresh_token'
  };

  try {
    console.log('--- Refresh token attempt ---');
    console.log('Using refresh token:', TRAKT_REFRESH_TOKEN);
    console.log('Client ID:', TRAKT_CLIENT_ID);
    console.log('Redirect URI:', redirectUriForRefresh);

    const res = await fetch(url, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' }
    });

    const data = await res.json();
    console.log('Trakt refresh response status:', res.status);
    console.log('Trakt refresh response body:', JSON.stringify(data));

    if (!res.ok) {
      console.error('Failed refresh token', res.status, data);
      return null;
    }

    TRAKT_ACCESS_TOKEN = data.access_token;
    TRAKT_REFRESH_TOKEN = data.refresh_token;

    console.log('Refreshed Trakt token successfully.');
    console.log('New refresh_token (store in ENV for persistence):', TRAKT_REFRESH_TOKEN);

    // alleen lokaal opslaan als ENV niet bestaat
    if (!process.env.TRAKT_REFRESH_TOKEN) {
      fs.writeFileSync(REFRESH_TOKEN_FILE, TRAKT_REFRESH_TOKEN, 'utf-8');
      console.log('Saved REFRESH_TOKEN to file for automatic use.');
    }

    return TRAKT_ACCESS_TOKEN;
  } catch (err) {
    console.error('Error refreshing token', err);
    return null;
  }
}

// Ensure we have a valid access token
async function ensureAccessToken() {
  if (TRAKT_ACCESS_TOKEN) return TRAKT_ACCESS_TOKEN;
  if (TRAKT_REFRESH_TOKEN) return await refreshAccessToken();
  return null;
}

// Low-level Trakt API GET helper
async function traktGet(path) {
  const token = await ensureAccessToken();
  const headers = {
    'trakt-api-version': '2',
    'trakt-api-key': TRAKT_CLIENT_ID
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const url = `https://api.trakt.tv${path}`;
  const res = await fetch(url, { headers });

  if (res.status === 401) {
    console.log('Unauthorized. Attempting token refresh...');
    if (TRAKT_REFRESH_TOKEN) {
      await refreshAccessToken();
      const token2 = TRAKT_ACCESS_TOKEN;
      if (token2) {
        headers['Authorization'] = `Bearer ${token2}`;
        const res2 = await fetch(url, { headers });
        if (!res2.ok) throw new Error(`Trakt API error ${res2.status}: ${await res2.text()}`);
        return res2.json();
      }
    }
    throw new Error('Unauthorized and no refresh possible.');
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Trakt API error ${res.status}: ${text}`);
  }

  return res.json();
}

// Fetch user's collected and watched shows
async function fetchUserShows() {
  const collected = await traktGet('/sync/collection/shows?extended=full');
  const watched = await traktGet('/sync/watched/shows?extended=full');

  const map = new Map();
  for (const it of collected || []) {
    const show = it.show || it;
    if (!show || !show.ids) continue;
    const id = show.ids.trakt || show.ids.slug || show.ids.tvdb || show.ids.tmdb;
    if (!id) continue;
    map.set(String(show.ids.trakt || id), show);
  }
  for (const it of watched || []) {
    const show = it.show || it;
    if (!show || !show.ids) continue;
    const id = show.ids.trakt || show.ids.slug || show.ids.tvdb || show.ids.tmdb;
    if (!id) continue;
    map.set(String(show.ids.trakt || id), show);
  }

  console.log(`Collected shows: ${collected.length} Watched shows: ${watched.length}`);
  return Array.from(map.values());
}

// Fetch latest available episode for a Trakt show
async function fetchLatestAvailableEpisodeForShow(traktId) {
  try {
    const seasons = await traktGet(`/shows/${traktId}/seasons?extended=episodes`);
    const now = Date.now();
    let best = null;

    for (const season of seasons || []) {
      if (!season.episodes) continue;
      for (const ep of season.episodes) {
        if (!ep || !ep.first_aired) continue;
        const ts = Date.parse(ep.first_aired);
        if (isNaN(ts)) continue;
        if (ts <= now) {
          if (!best || ts > best.ts) {
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
    }

    return best;
  } catch (err) {
    console.warn(`Failed to fetch seasons for show ${traktId}:`, err.message);
    return null;
  }
}

// Run promises with concurrency limit
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
    const remove = () => executing.delete(p);
    p.then(remove).catch(remove);
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
    return enqueue();
  }

  await enqueue();
  return Promise.all(results);
}

// Build catalog
async function buildCatalog() {
  if (catalogCache && (Date.now() - catalogCacheTs) / 1000 < CACHE_TTL_SECONDS) return catalogCache;

  const shows = await fetchUserShows();
  const jobs = shows.map(s => ({ show: s, traktId: s.ids && s.ids.trakt ? s.ids.trakt : null }));

  const resolved = await mapWithConcurrencyLimit(jobs, MAX_CONCURRENT_SEASON_REQUESTS, async (job) => {
    if (!job.traktId) return { show: job.show, latest: null };
    const latest = await fetchLatestAvailableEpisodeForShow(job.traktId);
    return { show: job.show, latest };
  });

  const withDates = resolved.map(r => {
    const show = r.show;
    const latest = r.latest;
    return {
      show,
      traktId: show.ids.trakt,
      tmdbId: show.ids && show.ids.tmdb ? show.ids.tmdb : null,
      name: show.title || show.name || '',
      year: show.year || null,
      overview: show.overview || '',
      latestEpisode: latest ? { ...latest, ts: latest.ts || Date.parse(latest.first_aired) } : null
    };
  });

  // Sorteer op nieuwste episode
  withDates.sort((a, b) => {
    if (a.latestEpisode && b.latestEpisode) return b.latestEpisode.ts - a.latestEpisode.ts;
    if (a.latestEpisode && !b.latestEpisode) return -1;
    if (!a.latestEpisode && b.latestEpisode) return 1;
    return 0;
  });

  const metas = withDates.map(s => {
    const showImages = s.show.images || {};
    let poster = null;
    if (showImages.poster?.full) poster = showImages.poster.full;
    else if (showImages.thumb?.full) poster = showImages.thumb.full;
    else if (showImages.fanart?.full) poster = showImages.fanart.full;

    const meta = {
      id: `tmdb:${s.tmdbId}`,
      type: 'series',
      name: s.name,
      ids: { tmdb: s.tmdbId },
      overview: s.overview || undefined,
      trakt: { id: s.traktId },
      poster,
      extra: {}
    };

    if (s.latestEpisode) {
      meta.extra.latestEpisode = {
        season: s.latestEpisode.season,
        number: s.latestEpisode.number,
        title: s.latestEpisode.title,
        first_aired: s.latestEpisode.first_aired
      };
      meta.description = `Laatst beschikbare aflevering: S${s.latestEpisode.season}E${s.latestEpisode.number} — ${s.latestEpisode.title}`;
    } else {
      meta.description = `Geen beschikbare (al uitgezonden) afleveringen gevonden.`;
    }

    return meta;
  });

  const catalog = { metas };
  catalogCache = catalog;
  catalogCacheTs = Date.now();
  return catalog;
}

// Stremio manifest
app.get('/manifest.json', (req, res) => {
  const manifest = {
    id: 'org.lastpostnl.trakt-latest-addon',
    version: '1.0.0',
    name: 'Trakt Latest Available Episode (TMDB-friendly)',
    description: 'Shows your Trakt collected/watched shows ordered by latest episode already available (not future). Exposes TMDB ids so a TMDB metadata provider can fetch localized metadata.',
    resources: ['catalog', 'meta'],
    types: ['series'],
    catalogs: [
      {
        type: 'series',
        id: 'trakt-latest',
        name: 'Trakt: latest available episode (collected/watched)'
      }
    ],
    idPrefixes: ['trakt:'],
    extra: {
      longDescription: 'Shows your Trakt collected/watched shows ordered by the most recent episode that has already aired. Returns TMDB ids for metadata provider usage.'
    }
  };
  res.json(manifest);
});

// Catalog endpoint
app.get(['/catalog/:id', '/catalog/:type/:id.json'], async (req, res) => {
  try {
    const id = req.params.id;
    if (id !== 'trakt-latest') return res.status(404).json({ metas: [] });
    const cat = await buildCatalog();
    res.json(cat);
  } catch (err) {
    console.error('Catalog error', err);
    res.status(500).json({ metas: [] });
  }
});

// Meta endpoint
app.get(['/meta/:type/:id', '/meta/:type/:id.json'], async (req, res) => {
  const { type, id } = req.params;
  try {
    if (type !== 'series') return res.status(404).send('Not found');
    const catalog = await buildCatalog();
    const meta = (catalog.metas || []).find(m => m.id === id);
    if (!meta) return res.status(404).send('Not found');
    res.json(meta);
  } catch (err) {
    console.error('Meta error', err);
    res.status(500).send('Error');
  }
});

// OAuth helpers
app.get('/auth', (req, res) => {
  if (!TRAKT_CLIENT_ID) return res.send('Set TRAKT_CLIENT_ID and TRAKT_CLIENT_SECRET in env to use OAuth flow.');
  const redirectUri = getRedirectUri(req);
  console.log('/auth redirect_uri used:', redirectUri);
  const url = `https://trakt.tv/oauth/authorize?response_type=code&client_id=${TRAKT_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('Missing code query param.');
  if (!TRAKT_CLIENT_ID || !TRAKT_CLIENT_SECRET) return res.status(500).send('TRAKT_CLIENT_ID or TRAKT_CLIENT_SECRET not configured.');

  const tokenUrl = 'https://api.trakt.tv/oauth/token';
  try {
    const redirectUri = getRedirectUri(req);
    console.log('/auth/callback redirect_uri used:', redirectUri);
    const body = {
      code,
      client_id: TRAKT_CLIENT_ID,
      client_secret: TRAKT_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    };
    const r = await fetch(tokenUrl, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await r.json();
    if (!r.ok) return res.status(500).send(`Token exchange failed: ${JSON.stringify(data)}`);

    TRAKT_ACCESS_TOKEN = data.access_token;
    TRAKT_REFRESH_TOKEN = data.refresh_token;

    if (!process.env.TRAKT_REFRESH_TOKEN) {
      fs.writeFileSync(REFRESH_TOKEN_FILE, TRAKT_REFRESH_TOKEN, 'utf-8');
      console.log('Saved REFRESH_TOKEN to file for automatic use.');
    }

    const html = `
      <h2>Trakt tokens received</h2>
      <p><strong>ACCESS_TOKEN</strong>: <code>${data.access_token}</code></p>
      <p><strong>REFRESH_TOKEN</strong>: <code>${data.refresh_token}</code></p>
      <p>To persist the addon across restarts, copy the <strong>REFRESH_TOKEN</strong> into your Render environment variable named <code>TRAKT_REFRESH_TOKEN</code>.</p>
      <p><a href="/manifest.json">Back to manifest</a></p>
    `;
    res.send(html);
  } catch (err) {
    console.error('OAuth callback error', err);
    res.status(500).send('OAuth token exchange failed.');
  }
});

// Health check
app.get('/', (req, res) => {
  res.send('Trakt Latest Addon is running. Manifest at /manifest.json');
});

// Startup
(async () => {
  if (TRAKT_REFRESH_TOKEN && TRAKT_CLIENT_ID && TRAKT_CLIENT_SECRET) {
    console.log('Refreshing access token at startup...');
    await refreshAccessToken();
  } else {
    if (!TRAKT_REFRESH_TOKEN) console.log('No TRAKT_REFRESH_TOKEN available. Use /auth to obtain tokens.');
  }

  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Manifest available at /manifest.json`);
  });
})();

