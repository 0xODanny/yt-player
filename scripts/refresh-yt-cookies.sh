#!/usr/bin/env bash
#
# Refresh the YouTube cookies file on the droplet from a logged-in
# browser on this Mac, then restart pm2 so yt-dlp picks up the new
# session.
#
# Why this exists:
#   YouTube's auth cookies (the __Secure-3PSID family) expire every
#   few weeks. When they do, yt-dlp starts returning
#   "Sign in to confirm you're not a bot" for music-restricted /
#   newer content, and the worker /stream endpoint hands a 502 to
#   the Capacitor app. Re-running this script swaps in fresh cookies
#   in one shot.
#
# Prerequisites (one-time):
#   - yt-dlp installed locally at ~/bin/yt-dlp (or anywhere on PATH).
#     If missing, the install command is at the bottom of this file.
#   - You're logged into youtube.com in Chrome / Brave / Firefox /
#     Safari on this Mac.
#   - You can SSH to the droplet as root with a key (passwordless).
#
# Usage:
#   ./scripts/refresh-yt-cookies.sh                 # uses defaults: chrome + droplet from env
#   ./scripts/refresh-yt-cookies.sh firefox         # different browser
#   YT_DROPLET=root@1.2.3.4 ./scripts/refresh-yt-cookies.sh
#
# Env overrides:
#   YT_BROWSER      browser to extract cookies from (chrome, brave, firefox, safari, edge)
#                   default: chrome
#   YT_DROPLET      SSH target for the worker droplet
#                   default: root@167.71.59.98
#   YT_COOKIES_PATH path of cookies file on the droplet
#                   default: /etc/yt-worker-cookies.txt
#   YT_PM2_PROCESS  pm2 process name to restart after upload
#                   default: yt-worker

set -euo pipefail

BROWSER="${1:-${YT_BROWSER:-chrome}}"
DROPLET="${YT_DROPLET:-root@167.71.59.98}"
COOKIES_REMOTE_PATH="${YT_COOKIES_PATH:-/etc/yt-worker-cookies.txt}"
PM2_PROCESS="${YT_PM2_PROCESS:-yt-worker}"

LOCAL_COOKIES="${TMPDIR:-/tmp}/yt-fresh-cookies-$$.txt"

cleanup() {
  rm -f "$LOCAL_COOKIES"
}
trap cleanup EXIT

if ! command -v yt-dlp >/dev/null 2>&1; then
  echo "[refresh-cookies] yt-dlp not on PATH. Install with:" >&2
  echo "  mkdir -p ~/bin && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos -o ~/bin/yt-dlp && chmod a+rx ~/bin/yt-dlp" >&2
  echo "  echo 'export PATH=\"\$HOME/bin:\$PATH\"' >> ~/.zshrc && source ~/.zshrc" >&2
  exit 1
fi

echo "[refresh-cookies] extracting cookies from $BROWSER (close the browser first if it errors with a lock)…"
# Use a known-safe video so yt-dlp doesn't accidentally hit a
# music-restricted item during the dummy request — Rick Astley's
# Never Gonna Give You Up is the long-time test fixture for this.
# `--skip-download` ensures no media file is fetched; we only want
# the cookie side-effect.
yt-dlp \
  --cookies-from-browser "$BROWSER" \
  --cookies "$LOCAL_COOKIES" \
  --skip-download \
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ" \
  > /dev/null 2>&1 || {
    echo "[refresh-cookies] yt-dlp failed. Common causes:" >&2
    echo "  1. $BROWSER is still running — quit it (Cmd+Q) and retry." >&2
    echo "  2. macOS Keychain denied access — open Keychain Access, find the" >&2
    echo "     entry for $BROWSER, set Access Control to Allow." >&2
    echo "  3. You're not logged into YouTube in $BROWSER." >&2
    exit 1
  }

# Sanity-check the export: a real authenticated session has the
# __Secure-3PSID family. If it's missing, the file is useless and
# we'd just be replacing one dead cookies file with another.
AUTH_COUNT=$(grep -cE '__Secure-3PSID|SAPISID' "$LOCAL_COOKIES" || true)
TOTAL_COUNT=$(wc -l < "$LOCAL_COOKIES" | tr -d ' ')

if [ "$AUTH_COUNT" -lt 2 ]; then
  echo "[refresh-cookies] FAIL: exported file has only $AUTH_COUNT auth cookies." >&2
  echo "  You're probably not actually signed into YouTube in $BROWSER." >&2
  echo "  Open https://www.youtube.com in $BROWSER, confirm your avatar shows" >&2
  echo "  top-right, then rerun this script." >&2
  exit 1
fi

echo "[refresh-cookies] exported $TOTAL_COUNT lines including $AUTH_COUNT auth cookies"

echo "[refresh-cookies] uploading to $DROPLET:$COOKIES_REMOTE_PATH …"
scp -q "$LOCAL_COOKIES" "$DROPLET:$COOKIES_REMOTE_PATH"

echo "[refresh-cookies] tightening permissions + restarting pm2…"
ssh "$DROPLET" "chmod 600 '$COOKIES_REMOTE_PATH' && pm2 restart '$PM2_PROCESS'" > /dev/null

echo "[refresh-cookies] done. fresh cookies live on the droplet."
echo "[refresh-cookies] tip: tail with — ssh $DROPLET 'pm2 logs $PM2_PROCESS --lines 0'"
