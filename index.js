const express = require('express');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const TRAKT_CLIENT_ID = process.env.TRAKT_CLIENT_ID;
const TRAKT_CLIENT_SECRET = process.env.TRAKT_CLIENT_SECRET;
let TRAKT_REFRESH_TOKEN = process.env.TRAKT_REFRESH_TOKEN || null;
let TRAKT_ACCESS_TOKEN = process.env.TRAKT_ACCESS_TOKEN || null;

// Cache
let catalogCache = null;
let catalogCacheTs = 0;
const CACHE_TTL_SECONDS = parseInt(process.env.CACHE_TTL_SECONDS || '300', 10);

// concurrency limit for season requests
const MAX_CONCURRENT_SEASON_REQUESTS = 5;

// Utility: sleep
const wait = ms => new Promise(r => setTimeout(r, ms));

// Helper: refresh access token using refresh token (Trakt)
async function refreshAccessToken() {
  if (!TRAKT_CLIENT_ID || !TRAKT_CLIENT_SECRET || !TRAKT_REFRESH_TOKEN) {
    console.log('Missing Trakt client id/secret or refresh token for token refresh.');
    return null;
  }
  const url = 'https://api.trakt.tv/oauth/token';
  const body = {
    refresh_token: TRAKT_REFRESH_TOKEN,
    client_id: TRAKT_CLIENT_ID,
    client_secret: TRAKT_CLIENT_SECRET,
    redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
    grant_type: 'refresh_token'
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' }
    });
    if (!res.ok) {
      const t = await res.text();
      console.error('Failed refresh token', res.status, t);
      return null;
    }
    const data = await res.json();
    TRAKT_ACCESS_TOKEN = data.access_token;
    TRAKT_REFRESH_TOKEN = data.refresh_token;
    console.log('Refreshed Trakt token. New refresh_token (store in Render env to persist):', TRAKT_REFRESH_TOKEN);
    return TRAKT_ACCESS_TOKEN;
  } catch (err) {
    console.error('Error refreshing token', err);
    return null;
  }
}

// Helper: ensure we have a valid access token (refresh immediately if refresh token present)
async function ensureAccessToken() {
  if (TRAKT_ACCESS_TOKEN) {
    return TRAKT_ACCESS_TOKEN;
  }
  if (TRAKT_REFRESH_TOKEN) {
    const token = await refreshAccessToken();
    return token;
  }
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
    // try refreshing token once
    console.log('Unauthorized. Attempting token refresh...');
    if (TRAKT_REFRESH_TOKEN) {
      await refreshAccessToken();
      const token2 = TRAKT_ACCESS_TOKEN;
      if (token2) {
        headers['Authorization'] = `Bearer ${token2}`;
        const res2 = await fetch(url, { headers });
        if (!res2.ok) {
          throw new Error(`Trakt API error ${res2.status}: ${await res2.text()}`);
        }
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

// Fetch user's collected shows and watched shows (merge)
async function fetchUserShows() {
  // endpoints require authentication
  const collected = await traktGet('/sync/collection/shows?extended=full');
  const watched = await traktGet('/sync/watched/shows?extended=full');

  // Each item contains `.show` object
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
  return Array.from(map.values());
}

// For a given Trakt show id, fetch seasons+episodes and find latest episode with first_aired <= now
async function fetchLatestAvailableEpisodeForShow(traktId) {
  // Use the seasons endpoint with episodes
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
    return best; // may be null if no aired episodes
  } catch (err) {
    console.warn(`Failed to fetch seasons for show ${traktId}:`, err.message);
    return null;
  }
}

// Helper to run promises with concurrency limit
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

// Build the catalog: fetch shows, fetch latest available episodes, sort, and map to Stremio metas
async function buildCatalog() {
  // caching
  const now = Math.floor(Date.now() / 1000);
  if (catalogCache && (Date.now() - catalogCacheTs) / 1000 < CACHE_TTL_SECONDS) {
    return catalogCache;
  }

  const shows = await fetchUserShows();
  // For each show, fetch latest available episode
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
      traktId: show.ids.trakt,
      tmdbId: show.ids && show.ids.tmdb ? show.ids.tmdb : null,
      name: show.title || show.name || '',
      year: show.year || null,
      overview: show.overview || '',
      latestEpisode: latest
    };
  });

  // Sort: shows with latestEpisode (newest first), then shows with none (last)
  withDates.sort((a, b) => {
    if (a.latestEpisode && b.latestEpisode) return b.latestEpisode.ts - a.latestEpisode.ts;
    if (a.latestEpisode && !b.latestEpisode) return -1;
    if (!a.latestEpisode && b.latestEpisode) return 1;
    return 0;
  });

  // Map to Stremio meta items.
  // Important: We intentionally DO NOT include provider-specific poster URLs (Cinemeta etc).
  // Instead we include `ids.tmdb` when available so the client's metadata provider (AIOMetadata -> TMDB) can fetch localized metadata/images.
  const metas = withDates.map(s => {
    const meta = {
      id: `trakt:${s.traktId}`,
      type: 'tv',
      name: s.name,
      // Provide TMDB id so AIOMetadata (set to TMDB) can fetch localized metadata/posters.
      ids: (s.tmdbId ? { tmdb: s.tmdbId } : undefined),
      overview: s.overview || undefined,
      trakt: { id: s.traktId },
      extra: {}
    };
    if (s.latestEpisode) {
      meta.extra.latestEpisode = {
        season: s.latestEpisode.season,
        number: s.latestEpisode.number,
        title: s.latestEpisode.title,
        first_aired: s.latestEpisode.first_aired
      };
      // Keep a short description in English — the metadata provider will typically override it with localized TMDB data.
      meta.description = `Latest available episode: S${s.latestEpisode.season}E${s.latestEpisode.number} — ${s.latestEpisode.title} (${s.latestEpisode.first_aired})`;
    } else {
      meta.description = `No available (already aired) episodes found for this show yet.`;
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
    types: ['tv'],
    catalogs: [
      {
        type: 'tv',
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
app.get('/catalog/:id', async (req, res) => {
  try {
    if (req.params.id !== 'trakt-latest') {
      return res.status(404).json({ metas: [] });
    }
    const cat = await buildCatalog();
    res.json(cat);
  } catch (err) {
    console.error('Catalog error', err);
    res.status(500).json({ metas: [] });
  }
});

// Meta endpoint: /meta/tv/:id  (stremio expects encoded id)
app.get('/meta/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  try {
    if (type !== 'tv') return res.status(404).send('Not found');
    // id is like trakt:12345
    const catalog = await buildCatalog();
    const meta = (catalog.metas || []).find(m => m.id === id);
    if (!meta) return res.status(404).send('Not found');
    res.json(meta);
  } catch (err) {
    console.error('Meta error', err);
    res.status(500).send('Error');
  }
});

// OAuth helpers to get tokens
app.get('/auth', (req, res) => {
  if (!TRAKT_CLIENT_ID) {
    return res.send('Set TRAKT_CLIENT_ID and TRAKT_CLIENT_SECRET in env to use OAuth flow.');
  }
  // Redirect user to Trakt authorize page
  const redirectUri = `${req.protocol}://${req.get('host')}/auth/callback`;
  const url = `https://trakt.tv/oauth/authorize?response_type=code&client_id=${TRAKT_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.status(400).send('Missing code query param.');
  }
  if (!TRAKT_CLIENT_ID || !TRAKT_CLIENT_SECRET) {
    return res.status(500).send('TRAKT_CLIENT_ID or TRAKT_CLIENT_SECRET not configured.');
  }
  const tokenUrl = 'https://api.trakt.tv/oauth/token';
  try {
    const body = {
      code,
      client_id: TRAKT_CLIENT_ID,
      client_secret: TRAKT_CLIENT_SECRET,
      redirect_uri: `${req.protocol}://${req.get('host')}/auth/callback`,
      grant_type: 'authorization_code'
    };
    const r = await fetch(tokenUrl, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await r.json();
    if (!r.ok) {
      return res.status(500).send(`Token exchange failed: ${JSON.stringify(data)}`);
    }
    // data contains access_token, refresh_token, expires_in, created_at, scope
    // We'll show it to user and suggest to copy refresh_token into Render env variables
    const html = `
      <h2>Trakt tokens received</h2>
      <p><strong>ACCESS_TOKEN</strong>: <code>${data.access_token}</code></p>
      <p><strong>REFRESH_TOKEN</strong>: <code>${data.refresh_token}</code></p>
      <p>To persist the addon across restarts, copy the <strong>REFRESH_TOKEN</strong> into your Render environment variable named <code>TRAKT_REFRESH_TOKEN</code>. Also set <code>TRAKT_CLIENT_ID</code> and <code>TRAKT_CLIENT_SECRET</code> in Render env variables.</p>
      <p>After that you can remove the tokens from this page or close it. The server will try to use the refresh token to obtain fresh access tokens automatically.</p>
      <p><a href="/manifest.json">Back to manifest</a></p>
    `;
    // update in-memory tokens (useful immediately)
    TRAKT_ACCESS_TOKEN = data.access_token;
    TRAKT_REFRESH_TOKEN = data.refresh_token;
    res.send(html);
  } catch (err) {
    console.error('OAuth callback error', err);
    res.status(500).send('OAuth token exchange failed.');
  }
});

// Health
app.get('/', (req, res) => {
  res.send('Trakt Latest Addon is running. Manifest at /manifest.json');
});

// Try to refresh at startup if we have a refresh token
(async () => {
  if (TRAKT_REFRESH_TOKEN && TRAKT_CLIENT_ID && TRAKT_CLIENT_SECRET) {
    console.log('Refreshing access token at startup...');
    await refreshAccessToken();
  } else {
    if (!TRAKT_REFRESH_TOKEN) console.log('No TRAKT_REFRESH_TOKEN provided. You can use /auth to obtain tokens.');
  }

  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Manifest available at /manifest.json`);
  });
})();