```markdown

\# Stremio Addon: Trakt "Latest Available Episode" Catalog (TMDB-friendly)



This minimal Stremio addon shows the shows you collected / watched on Trakt, sorted by the latest available episode (episodes with first\_aired in the past or now — future episodes are excluded). It is designed to run on Render (free instance).



Important: This addon now exposes TMDB IDs for shows (when available) instead of supplying Cinemeta images. That allows your Stremio client (using AIOMetadata configured to TMDB) to fetch localized metadata (posters, descriptions) from TMDB in the language you've set (Dutch).



Features

\- Uses Trakt API to fetch your collected and watched shows

\- For each show, finds the latest episode with `first\_aired <= now`

\- Sorts shows by that latest available episode (newest first)

\- Returns a single catalog row (catalog id: `trakt-latest`)

\- Adds `ids.tmdb` to each meta so your TMDB metadata provider (AIOMetadata) can provide localized metadata and images

\- OAuth helper to obtain a refresh token (recommended to persist on Render)



Files

\- `package.json` — Node app dependencies

\- `index.js` — main server (TMDB-friendly meta output)

\- `README.md` — this file



Environment variables (set on Render)

\- `PORT` (Render sets automatically)

\- `TRAKT\_CLIENT\_ID` — your Trakt app client id

\- `TRAKT\_CLIENT\_SECRET` — your Trakt app client secret

\- One of:

&nbsp; - `TRAKT\_REFRESH\_TOKEN` — recommended: a refresh token (you can produce it via the OAuth flow below)

&nbsp; - OR `TRAKT\_ACCESS\_TOKEN` — a single access token (will typically expire; prefer refresh token)

\- Optional `CACHE\_TTL\_SECONDS` — catalog cache TTL (default 300)



How to create a Trakt app and get tokens

1\. Create a Trakt API app: https://trakt.tv/oauth/applications

&nbsp;  - For redirect URI use `https://<your-render-service>.onrender.com/auth/callback` or `urn:ietf:wg:oauth:2.0:oob` for manual flow.

2\. Set `TRAKT\_CLIENT\_ID` and `TRAKT\_CLIENT\_SECRET` in your Render service env variables.

3\. Deploy the addon to Render and visit `https://<your-render-service>.onrender.com/auth`:

&nbsp;  - Follow the Trakt OAuth flow; on success the page will show `access\_token` and `refresh\_token`.

&nbsp;  - Copy `TRAKT\_REFRESH\_TOKEN` into Render env variables to persist across restarts.



Deploying to Render

\- Create a new Web Service on Render from this repo (or manually upload files).

\- Set the environment variables described above.

\- Render will run `npm start` — this starts the server on the port given by Render.



Stremio usage

\- Add the addon to Stremio via URL: `https://<your-render-service>.onrender.com/manifest.json`

\- The catalog id is `trakt-latest` and type is `tv`. The catalog returns `metas` that include `ids.tmdb` when Trakt provides it.

\- Since you use AIOMetadata -> TMDB (Dutch), Stremio should fetch posters and localized text directly from TMDB for each item that includes a TMDB id.



Notes \& recommendations

\- The addon intentionally avoids embedding Cinemeta/other provider images so your TMDB metadata provider can return localized assets.

\- If a show lacks a TMDB id in Trakt, the addon still returns the item with a Trakt id; such items may not get TMDB metadata unless you map them otherwise.

\- For many shows this code will call the Trakt seasons/episodes endpoint a lot. If you have hundreds of shows, consider increasing CACHE\_TTL\_SECONDS to reduce Trakt load.

```

