# Pepinho Player

A Next.js App Router PWA paired with a small Express worker for downloading non-copyrighted YouTube videos and direct media URLs.

> Internal codename: **yt-player**. The repo and code modules keep that name; user-facing strings all use **Pepinho Player**.

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

### Build the debug APK (for iteration)

```bash
npm run build:capacitor          # static export + cap sync android
npm run cap:open:android         # launches Android Studio
# In Android Studio: Build → Generate App Bundles or APKs → Generate APKs
# The APK lands at android/app/build/outputs/apk/debug/app-debug.apk
```

Each rebuild of the debug APK generates a new random signing key, so
reinstalling overwrites app data. Use the release APK below for daily
driving.

### One-time: generate a release keystore

Reinstalling an Android app with a different signing key wipes its
data. To preserve your library across rebuilds, sign every release
APK with the same keystore.

```bash
cd android
keytool -genkey -v \
  -keystore yt-player-release.keystore \
  -alias yt-player \
  -keyalg RSA -keysize 2048 -validity 10000
```

Answer the prompts (name, org, etc. — values don't matter for
sideload). Pick a password you'll remember. Back this `.keystore`
file up somewhere safe — losing it means you can never publish an
update to the same installed app again.

Then create `android/signing.properties` (gitignored) from the
template:

```bash
cp signing.properties.example signing.properties
# edit signing.properties: storePassword + keyPassword to the
# values you used in keytool above
```

### Build the release APK

```bash
npm run build:android:release
```

Outputs `android/app/build/outputs/apk/release/app-release.apk`. That
file is signed by your keystore — install over any existing release
APK and the library + settings survive.

To install over USB:

```bash
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

The app ID is `lol.pepinho.ytplayer` (configured in
`capacitor.config.ts`).

## Custom Icon & Splash

The Android app currently ships with the default Capacitor launcher
on a black adaptive-icon background, and a solid-black splash screen
on every Android version (Android 12+ uses the native SplashScreen
API, 11 and below use a legacy drawable — both point at the same
`@color/splashBackground = #000000`).

To swap in custom branding:

1. Drop a 1024×1024 transparent PNG of your logo at
   `resources/logo.png` (see `resources/README.md` for details).
2. Regenerate:

   ```bash
   npm run assets:generate
   npm run build:android:release
   adb install -r android/app/build/outputs/apk/release/app-release.apk
   ```

The generator rewrites every density of the launcher icon,
adaptive-icon foreground, and splash image. The black background is
hard-coded in the `assets:generate` script in `package.json` — edit
the `--iconBackgroundColor` / `--splashBackgroundColor` flags to
change it.

## Building APKs from GitHub Actions

`.github/workflows/android-apk.yml` builds a signed release APK on
every push to `main` (and on pull requests, but without keystore
access from forks). The artifact lives under the run's **Artifacts**
panel for 30 days; download it and `adb install -r` to update your
phone without ever opening Android Studio.

### One-time setup

Under **Settings → Secrets and variables → Actions** on the repo,
add these four secrets:

| Secret | Value |
|--------|-------|
| `NEXT_PUBLIC_WORKER_API_URL` | `https://worker.pepinho.lol` |
| `NEXT_PUBLIC_WORKER_API_KEY` | The same key your local `.env.production.local` uses (or blank if you don't gate the worker on a key) |
| `KEYSTORE_BASE64` | The release keystore, base64-encoded. Generate locally with `base64 -i android/yt-player-release.keystore \| pbcopy` then paste in. |
| `KEYSTORE_PASSWORD` | The store password you set when you ran `keytool` |
| `KEY_ALIAS` | `yt-player` (or whatever `-alias` you passed to `keytool`) |
| `KEY_PASSWORD` | The key password (same as the store password if you didn't override) |

`KEYSTORE_BASE64` is optional. If you skip it the workflow still
runs; it just produces an `app-release-unsigned.apk`, which is
fine for casual testing but can't reinstall over an existing
signed install.

### Triggering on demand

Workflow has `workflow_dispatch` enabled, so you can rebuild the
APK from the Actions tab without pushing a new commit. Handy after
rotating cookies on the droplet but not touching app code.

## Refreshing YouTube Cookies

YouTube's session cookies expire every few weeks. When that happens,
yt-dlp starts returning `Sign in to confirm you're not a bot` for
music-restricted and newer content, and the worker /stream endpoint
hands a 502 to the Capacitor app.

To swap in a fresh set of cookies from a logged-in browser on your
Mac to the droplet in one shot:

```bash
npm run refresh:cookies            # uses Chrome by default
npm run refresh:cookies firefox    # any browser supported by yt-dlp
```

The script:

1. Runs `yt-dlp --cookies-from-browser <browser>` locally to extract
   the full cookie set (including HttpOnly auth cookies that
   browser extensions can't see).
2. Sanity-checks that the file actually contains the `__Secure-3PSID`
   / `SAPISID` family — fails fast if you're not actually signed in.
3. Uploads to `/etc/yt-worker-cookies.txt` on the droplet over scp.
4. Runs `chmod 600` + `pm2 restart yt-worker` over ssh.

Defaults assume the droplet at `root@167.71.59.98` and pm2 process
name `yt-worker`. Override with env vars:

```bash
YT_DROPLET=root@1.2.3.4 npm run refresh:cookies
YT_PM2_PROCESS=other-worker npm run refresh:cookies
```

Important: close the browser (Cmd+Q) before running. yt-dlp can't
read the cookies DB while the browser holds its write lock.

## Status

- Frontend PWA with installable manifest and offline shell — ✓
- Worker performs real `yt-dlp` downloads with progress reporting — ✓
- MP3 + MP4 with quality selection down to 360p — ✓
- Ad-free streaming via direct googlevideo URLs — ✓
- Android-native direct downloads (Capacitor app only) — ✓
- Resume prompt for direct downloads interrupted by force-kill — ✓
- Recent jobs list, progress bar, online indicator, URL classification hints — ✓
- Use only on content you own or that is in the public domain.
