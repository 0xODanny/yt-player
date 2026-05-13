/**
 * Human-facing release number (not the git SHA). Bump when you ship
 * user-visible changes; keep notes short and non-technical.
 *
 * Fallback when `NEXT_PUBLIC_APP_RELEASE_VERSION` is not set at build time.
 */
export const APP_RELEASE_VERSION = "1.1.13";

export function getDisplayedReleaseVersion(): string {
  if (typeof process !== "undefined" && process.env.NEXT_PUBLIC_APP_RELEASE_VERSION) {
    return process.env.NEXT_PUBLIC_APP_RELEASE_VERSION;
  }
  return APP_RELEASE_VERSION;
}

/**
 * Compare two dotted version strings (e.g. "1.2.3"). Non-numeric parts
 * are stripped per segment; missing segments count as 0.
 */
export function compareSemanticVersions(a: string, b: string): number {
  const seg = (s: string) =>
    s.split(".").map((part) => {
      const m = part.match(/\d+/);
      return m ? parseInt(m[0], 10) : 0;
    });
  const pa = seg(a.trim() || "0");
  const pb = seg(b.trim() || "0");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da < db) return -1;
    if (da > db) return 1;
  }
  return 0;
}

export type ReleaseNoteEntry = {
  version: string;
  title: string;
  items: readonly string[];
};

export const RELEASE_NOTES: readonly ReleaseNoteEntry[] = [
  {
    version: "1.1.13",
    title: "May 2026",
    items: [
      "Critical playback fix: do not attach high-rate progress listeners when library or downloaded media uses native controls (expanded player). That React traffic was glitching audio/video on Safari and Brave. Polling only runs for YouTube streams (custom scrubber) or when the mini dock is visible.",
      "Streams: drop the progress event (very chatty during buffering); debounce rapid loadeddata/canplay bursts.",
    ],
  },
  {
    version: "1.1.12",
    title: "May 2026",
    items: [
      "Playback: moved progress listeners off useLayoutEffect (sync React work was blocking the main thread and glitching audio — streams and saved MP3s). Clock UI updates use startTransition; removed the extra interval tick.",
      "Media Session: avoid spamming play/pause state when the OS re-fires events.",
      "Service worker: never route audio/video subresource fetches through stale-while-revalidate (pass-through fetch only).",
    ],
  },
  {
    version: "1.1.11",
    title: "May 2026",
    items: [
      "Stream player: fixed Audio-only / Video switching leaving event listeners on the wrong element (stuttery or silent playback). Progress updates are throttled so the UI doesn’t hammer the main thread (cooler laptops, smoother audio).",
      "Stream video: retry play() shortly after open when autoplay is deferred (black 0:00 screen in some browsers). Removed the CDN disclaimer line under the scrubber.",
      "Toolbar: Audio-only / PiP pills use primary text color; stream timecode uses body text color; buffering strip uses a light opacity pulse instead of sliding transforms.",
    ],
  },
  {
    version: "1.1.10",
    title: "May 2026",
    items: [
      "Play audio / Play video (no download): native browser controls hid the real video inside the control strip and broke time display on many phones. Streams now use our own scrubber and play/pause; audio-only streams use the audio player again.",
      "Progress while buffering: the bar can use loaded bytes when duration is still unknown; a small buffering hint shows while data arrives.",
      "Smoke: Search preset chips (Play audio, Play video, …) use dark text on light pills so they match the rest of the theme.",
    ],
  },
  {
    version: "1.1.9",
    title: "May 2026",
    items: [
      "Mini player: playback no longer stops or glitches when minimized (browsers were suspending media hidden at full opacity zero). Dock play/pause uses triangle and bar icons instead of emoji.",
      "Stream “Play audio” uses the same video pipeline as “Play video” where Safari/PWA needs it; progress bar reads duration from seekable ranges when metadata is late.",
      "Smoke theme: Audio-only, Picture-in-Picture, dock, and header buttons use dark text on light control surfaces so labels stay readable.",
    ],
  },
  {
    version: "1.1.8",
    title: "May 2026",
    items: [
      "Mini player: minimize full-screen playback to a bottom bar (thumbnail, seek, play/pause, expand, stop) so you can keep searching or browsing the library while audio or video plays. Same shell for the PWA and Android APK.",
      "Smoke theme: Stop and Open on download rows are easier to see (brighter stop, Open styled like a primary action).",
    ],
  },
  {
    version: "1.1.7",
    title: "May 2026",
    items: [
      "Library manifest repairs (e.g. type/format for older saves) are now written back to storage when you open the app, not only kept in memory — exports and future updates see the fixed metadata.",
    ],
  },
  {
    version: "1.1.6",
    title: "May 2026",
    items: [
      "Android APK: library playback from older saves no longer forces a video surface when the file is audio (manifest repair + correct MIME on blob URLs). Library videos open in Audio mode first so the screen can stay off — tap Video mode to watch.",
    ],
  },
  {
    version: "1.1.5",
    title: "May 2026",
    items: [
      "Themes (OG Pepinho, Smoke, Paper) in Settings, smaller Search preset labels, clearer update and share text, and a friendlier “check for updates” when your version matches the public release.",
      "Smoke theme: settings descriptions match the readable blue-gray tone of What’s new; Library playback stays on one row with compact 🔁 Folder and 🔂 One controls.",
    ],
  },
  {
    version: "1.1.4",
    title: "May 2026",
    items: [
      "Library export filename is now pepinho-player-dd-mm-yyyy-hh-mm.json so backups are easier to spot.",
    ],
  },
  {
    version: "1.1.3",
    title: "May 2026",
    items: [
      "Android APK: Export library now opens the system share sheet (same as exporting a track) — WebView was ignoring the old download link.",
    ],
  },
  {
    version: "1.1.2",
    title: "May 2026",
    items: [
      "Tips: new “Back up your library” section and Share Pepinho (link + message). Footer: site ™, year, support email, and Share app.",
    ],
  },
  {
    version: "1.1.1",
    title: "May 2026",
    items: [
      "New Tips (lightbulb) in the header: Samsung/Android battery steps so Pepinho isn’t auto-sleeped, plus playback and library hints.",
    ],
  },
  {
    version: "1.1.0",
    title: "May 2026",
    items: [
      "Download rows now put Stop and Open under the thumbnail, with progress on the picture itself.",
      "After something saves to your library, tap Open to play — playback no longer starts by itself.",
      "Faster download status checks and clearer progress when the server can’t show an exact percent yet.",
      "New About section in Settings with version, what’s new, and a check for the latest build.",
      "Install hints only show in a normal browser tab — not in the installed app or Android APK.",
    ],
  },
];
