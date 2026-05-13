/**
 * Human-facing release number (not the git SHA). Bump when you ship
 * user-visible changes; keep notes short and non-technical.
 *
 * Fallback when `NEXT_PUBLIC_APP_RELEASE_VERSION` is not set at build time.
 */
export const APP_RELEASE_VERSION = "1.1.5";

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
    version: "1.1.5",
    title: "May 2026",
    items: [
      "Themes (OG Pepinho, Smoke, Paper) in Settings, smaller Search preset labels, clearer update and share text, and a friendlier “check for updates” when your version matches the public release.",
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
