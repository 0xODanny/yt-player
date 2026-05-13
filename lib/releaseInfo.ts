/**
 * Human-facing release number (not the git SHA). Bump when you ship
 * user-visible changes; keep notes short and non-technical.
 *
 * Fallback when `NEXT_PUBLIC_APP_RELEASE_VERSION` is not set at build time.
 */
export const APP_RELEASE_VERSION = "1.1.0";

export function getDisplayedReleaseVersion(): string {
  if (typeof process !== "undefined" && process.env.NEXT_PUBLIC_APP_RELEASE_VERSION) {
    return process.env.NEXT_PUBLIC_APP_RELEASE_VERSION;
  }
  return APP_RELEASE_VERSION;
}

export type ReleaseNoteEntry = {
  version: string;
  title: string;
  items: readonly string[];
};

export const RELEASE_NOTES: readonly ReleaseNoteEntry[] = [
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
