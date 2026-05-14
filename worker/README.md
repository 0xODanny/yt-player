# yt-worker

`yt-worker` is a lightweight Express + TypeScript backend service intended to run separately from the Next.js frontend.

It exposes authenticated job endpoints and serves downloaded media files. yt-dlp does the actual downloading, ffmpeg is used for audio extraction and merging.

## Features

- Express HTTP API with TypeScript
- Bearer token protection for job endpoints
- CORS restricted by `ALLOWED_ORIGIN`
- Real `yt-dlp` downloads for YouTube and other supported sources
- Direct media file URL downloads (`.mp3`, `.mp4`, `.m4a`, `.wav`, `.mov`, `.webm`)
- Per-job progress reported by parsing yt-dlp `--newline` output
- Files served from `/tmp/yt-worker-downloads` and auto-pruned after 2 hours

## Scripts

Install dependencies:

```bash
npm install
```

Run in development:

```bash
npm run dev
```

Build for production:

```bash
npm run build
```

Run the compiled server:

```bash
npm run start
```

Run under PM2 in production:

```bash
npm run start:prod
```

## Environment Variables

- `PORT`
  Port for the worker server. Defaults to `3001`.
- `WORKER_API_SECRET`
  Shared bearer token required by `POST /jobs` and `GET /jobs/:id`.
- `ALLOWED_ORIGIN`
  Comma-separated allowed browser `Origin` headers for CORS. The server merges in `https://pepinho.lol` and `https://www.pepinho.lol` automatically (two different origins; iOS PWAs keep the install host).
- `WORKER_PUBLIC_URL`
  Optional. Public base URL (e.g. `https://worker.pepinho.lol`) used to build absolute `downloadUrl` values returned to the frontend. Set this in production so the frontend always gets correct `https://` links even if your reverse proxy doesn't forward `X-Forwarded-Proto`.
- `YT_DLP_BINARY`
  Optional path/name of the `yt-dlp` executable. Defaults to `yt-dlp` (must be on `$PATH`).
- `FFMPEG_BINARY`
  Optional path/name of the `ffmpeg` executable used by yt-dlp for audio extraction and stream merging. Defaults to `ffmpeg` (must be on `$PATH`).
- `YT_DLP_PLAYER_CLIENTS`
  Optional comma-separated list of YouTube player clients yt-dlp should try, in order. Defaults to `web_safari,mweb,android`. These tend to be less aggressively bot-checked than the default `web` client.
- `YT_DLP_COOKIES`
  Optional path to a Netscape-format cookies file. If set, yt-dlp will pass it via `--cookies`. Use this when YouTube returns "Sign in to confirm you're not a bot." on cloud IPs.
- `YT_DLP_REMOTE_COMPONENTS`
  yt-dlp `--remote-components` value. Defaults to `ejs:github`, which lets yt-dlp fetch the embedded JavaScript challenge solver from the official yt-dlp GitHub release (one-time download). Required for YouTube's "n challenge" decryption in recent yt-dlp versions. Set to an empty string to disable remote downloads.

Copy `.env.example` to `.env` or supply these values through your deployment platform.

`dotenv` is loaded by the server entrypoint in both local and production runs.

## Ubuntu Deployment

Example setup for a DigitalOcean Ubuntu droplet:

Install Node.js:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Install ffmpeg, Python pip, and yt-dlp:

```bash
sudo apt install -y python3-pip ffmpeg
python3 -m pip install -U yt-dlp --break-system-packages
```

Install project dependencies:

```bash
npm install
```

Build the worker:

```bash
npm run build
```

Start with PM2:

```bash
npx pm2 start dist/index.js --name yt-worker --update-env
```

Optional PM2 process list:

```bash
npx pm2 status
```

## Endpoints

- `GET /health`
  Returns a simple readiness response.
- `POST /jobs`
  Requires `Authorization: Bearer <WORKER_API_SECRET>` and starts a real `yt-dlp` (or direct media URL) download. Returns the queued job descriptor.
- `GET /jobs/:id`
  Requires the same auth and returns the live status, progress, metadata, and (when complete) the absolute `downloadUrl`.
- `GET /files/:filename`
  Serves a downloaded file from `/tmp/yt-worker-downloads`.

## Current Status

The worker performs real downloads with `yt-dlp` and serves the resulting files. Jobs are kept in memory only (no database) and files are pruned after 2 hours.