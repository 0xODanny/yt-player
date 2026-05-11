# YT Local Tool

A Next.js App Router PWA paired with a small Express worker for downloading non-copyrighted YouTube videos and direct media URLs.

The frontend submits jobs and polls progress. The worker runs `yt-dlp` (and `ffmpeg` for audio extraction / stream merging) to actually fetch the media, then serves the resulting file back through `/files/:id`.

## Production Topology

| Tier      | Host                | Domain                  | Responsibility                                         |
| --------- | ------------------- | ----------------------- | ------------------------------------------------------ |
| Frontend  | Vercel              | `pepinho.lol`           | Next.js PWA, polling UI, calls the worker              |
| Worker    | DigitalOcean        | `worker.pepinho.lol`    | `yt-dlp` + `ffmpeg`, file storage, `/files/...`        |

The frontend on Vercel is **stateless** — it only talks to the worker via `NEXT_PUBLIC_WORKER_API_URL` using `NEXT_PUBLIC_WORKER_API_KEY` as a bearer token. All long-running work happens on DigitalOcean.

When `NEXT_PUBLIC_WORKER_API_URL` is unset, the frontend falls back to the in-Next.js `/api/jobs` routes that simulate a job (handy for local dev without the worker).

## Repository Layout

- `app/`, `lib/`, `public/` — Next.js PWA frontend
- `public/sw.js` — service worker that caches the app shell for offline use
- `worker/` — standalone Express worker (`yt-dlp` + `ffmpeg`)

## Frontend Quick Start

```bash
npm install
npm run dev      # http://localhost:3000
npm run build
npm run start
npm run typecheck
```

### Frontend Environment

Copy `.env.local.example` to `.env.local`. In production those values are set in the Vercel project settings instead.

- `NEXT_PUBLIC_WORKER_API_URL` — e.g. `https://worker.pepinho.lol`
- `NEXT_PUBLIC_WORKER_API_KEY` — must equal the worker's `WORKER_API_SECRET`

## Worker Quick Start

```bash
cd worker
npm install
npm run dev      # http://localhost:3001
```

See `worker/README.md` for details. Worker env (`worker/.env`, gitignored):

- `PORT` (default `3001`)
- `WORKER_API_SECRET` — required, shared with the frontend
- `ALLOWED_ORIGIN` — exact browser origin allowed by CORS (e.g. `https://pepinho.lol`)
- `YT_DLP_BINARY`, `FFMPEG_BINARY` — optional binary overrides

## PWA

- `public/manifest.json` — installable app metadata
- `public/sw.js` — hand-rolled service worker (network-first for HTML, stale-while-revalidate for static assets, never caches `/api/*`, `/files/*`, or cross-origin)
- `app/sw-register.tsx` — registers the SW only in production

## Supported Output

- **MP3** — extracted via ffmpeg from any yt-dlp-supported source or direct media URL
- **MP4** — merged best video + best audio, capped by selected quality:
  - Best available
  - Up to 1080p
  - Up to 720p
  - Up to 480p (lighter)
  - Up to 360p (data saver)
  - Audio only (forces MP3 extraction)

Direct media URLs (`.mp3`, `.mp4`, `.m4a`, `.wav`, `.mov`, `.webm`) are downloaded as-is in MP3 mode.

## Vercel Deployment

1. Connect the GitHub repo to Vercel (already done for `pepinho.lol`).
2. In Project Settings → Environment Variables, add:
   - `NEXT_PUBLIC_WORKER_API_URL=https://worker.pepinho.lol`
   - `NEXT_PUBLIC_WORKER_API_KEY=<same long random string as the worker>`
3. Deployments are triggered automatically on pushes to `main`.

## DigitalOcean Worker Deployment

See `worker/README.md` for the full Ubuntu / PM2 / nginx setup. Summary:

```bash
sudo apt install -y python3-pip ffmpeg
python3 -m pip install -U yt-dlp --break-system-packages
cd worker
npm install
npm run build
npm run start:prod        # PM2
```

`worker.pepinho.lol` should terminate TLS at nginx and proxy to the PM2-managed Node process on `127.0.0.1:3001`. The worker reads `X-Forwarded-Proto` so the `downloadUrl` it returns to the frontend is correctly `https://worker.pepinho.lol/files/...`.

## Android App (Capacitor)

The PWA can be packaged as a native Android app to unlock **direct
downloads** that bypass the IPRoyal residential proxy entirely:

- Worker resolves the googlevideo.com URL via `yt-dlp` (small metadata
  hit through IPRoyal, ~50 KB).
- Native Capacitor HTTP code on the phone fetches the actual bytes
  over cellular / WiFi using the device's residential IP — neither
  browser CORS rules nor Google's ASN block on the worker's
  datacenter IP apply, so it just works.
- Saved into the in-app OPFS library or shared out via the system
  Share sheet to Files / Photos / Downloads.

These chips (`⇣ Audio (phone data)`, `⇣ Video (phone data)`) only
render inside the native Android wrapper — see `lib/platform.ts`.

### One-time setup

1. Install Android Studio (Hedgehog / 2023.1.1+ recommended).
2. From `yt-local-tool/`:
   ```bash
   npm install                                # pulls Capacitor deps
   npx cap add android                        # generates android/ once
   ```
3. Open `android/local.properties` and set:
   ```
   sdk.dir=/Users/<you>/Library/Android/sdk
   ```

### Build the APK

```bash
npm run build:capacitor          # static export + cap sync android
npm run cap:open:android         # launches Android Studio
# In Android Studio: Build → Build Bundle(s) / APK(s) → Build APK(s)
# The APK lands at android/app/build/outputs/apk/debug/app-debug.apk
```

For a release-signed APK suitable for sideload that survives
reinstall:

```bash
cd android
./gradlew assembleRelease
# Outputs android/app/build/outputs/apk/release/app-release-unsigned.apk
# Sign with apksigner using your own keystore.
```

The app ID is `lol.pepinho.ytplayer` (configured in
`capacitor.config.ts`).

## Status

- Frontend PWA with installable manifest and offline shell — ✓
- Worker performs real `yt-dlp` downloads with progress reporting — ✓
- MP3 + MP4 with quality selection down to 360p — ✓
- Ad-free streaming via direct googlevideo URLs — ✓
- Android-native direct downloads (Capacitor app only) — ✓
- Recent jobs list, progress bar, online indicator, URL classification hints — ✓
- Use only on content you own or that is in the public domain.
