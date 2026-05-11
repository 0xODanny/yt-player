/**
 * Persistent tracking for Android-native direct downloads in flight.
 *
 * Problem
 * -------
 * A direct download (lib/nativeDownload.ts) runs through
 * @capacitor/filesystem's native HTTP, which lives on a background
 * thread inside the app's process. That's good news for screen-lock
 * and app-switch: the bytes keep flowing even when the WebView is
 * paused. It's bad news for two cases:
 *   1. The user swipes the app away from the recents tray (force-
 *      kill), killing the process and dropping the in-flight HTTP
 *      with no chance to react.
 *   2. The OS OOM-kills the app, which on cheap Androids can happen
 *      mid-download.
 * When the user reopens the app the in-memory `downloads` Map in
 * SearchView is empty. The download is gone, no file in the OPFS
 * library, and the user has zero idea what happened.
 *
 * Solution
 * --------
 * Mirror every direct download's metadata to localStorage at start.
 * Clear on success/abort/error. On the next SearchView mount, any
 * entries still in localStorage are by definition downloads that
 * were interrupted by a force-kill / OOM / power loss / similar.
 *
 * SearchView reads these as "orphaned downloads" once at mount, then
 * clears them from storage and stashes them in component state to
 * render a "Resume?" banner. The banner offers Retry (re-run the
 * full direct-download flow with the persisted metadata) or Dismiss.
 *
 * Why not just write to disk every progress tick? Two reasons:
 *   1. Progress tracking is best-effort even in the happy path —
 *      reflecting partial bytes that ended up nowhere reachable
 *      would mislead more than help.
 *   2. Direct downloads write to Directory.Cache, which the OS may
 *      blow away independently of our process. There's no partial
 *      file to resume from, so an orphan entry is intrinsically
 *      "start over" not "resume from byte N".
 *
 * Stale-entry pruning
 * -------------------
 * Entries older than STALE_THRESHOLD_MS are silently dropped on
 * read. Rationale: if a download has been "in flight" for more than
 * 30 minutes without our process ever clearing it, something went
 * wrong long ago and the URL (a signed googlevideo.com URL valid for
 * ~5 hours) is fine to retry, but the user almost certainly doesn't
 * remember it. We surface only the recent set.
 */

const STORAGE_KEY = "yt-local-tool:inflight-direct-downloads";
// 30 minutes: long enough to cover slow 1080p over LTE, short enough
// that a user reopening the next day doesn't see a stale prompt.
const STALE_THRESHOLD_MS = 30 * 60 * 1000;

export type InflightPreset = "direct-audio" | "direct-video";

export type InflightDirectDownload = {
  /** Stable id; the canonical form is `${videoId}-${preset}-${startedAt}`. */
  id: string;
  videoId: string;
  videoTitle: string;
  channelTitle: string;
  /** Single thumbnail URL string (not the full thumbnails[] array). */
  thumbnail: string | null;
  /** Approx duration in seconds; null if the search result didn't have one. */
  durationSeconds: number | null;
  preset: InflightPreset;
  /** Date.now() at the time the download started. */
  startedAt: number;
};

function safeReadAll(): InflightDirectDownload[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (entry): entry is InflightDirectDownload =>
        entry &&
        typeof entry.id === "string" &&
        typeof entry.videoId === "string" &&
        typeof entry.startedAt === "number" &&
        (entry.preset === "direct-audio" || entry.preset === "direct-video"),
    );
  } catch {
    return [];
  }
}

function safeWriteAll(entries: InflightDirectDownload[]): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (entries.length === 0) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    }
  } catch {
    // localStorage may be full or denied; nothing actionable here.
  }
}

/**
 * Compose the canonical id for an in-flight entry. Made deterministic
 * (same args → same id) so re-running registerInflight for the same
 * download doesn't add a duplicate row.
 */
export function inflightIdFor(
  videoId: string,
  preset: InflightPreset,
  startedAt: number,
): string {
  return `${videoId}-${preset}-${startedAt}`;
}

export function registerInflight(entry: InflightDirectDownload): void {
  const current = safeReadAll();
  // Replace any existing row with this id so progress restarts don't
  // duplicate. (In practice ids include startedAt so this branch is
  // rarely hit, but it makes the function idempotent.)
  const next = [entry, ...current.filter((e) => e.id !== entry.id)];
  safeWriteAll(next);
}

export function clearInflight(id: string): void {
  const current = safeReadAll();
  const next = current.filter((e) => e.id !== id);
  if (next.length === current.length) {
    return;
  }
  safeWriteAll(next);
}

/**
 * Read every entry that isn't stale (per STALE_THRESHOLD_MS) and
 * remove the stale ones from storage as a side effect. Intended to
 * be called exactly once on SearchView mount; the caller then owns
 * the returned list as "orphaned downloads from previous sessions".
 *
 * Note: this does NOT clear the returned entries from storage.
 * Callers are responsible for calling clearInflight() once they've
 * either retried or dismissed each orphan. That way a partial mid-
 * banner crash (e.g. user hits Retry, then immediately swipes the
 * app away) doesn't lose the entry.
 */
export function takeOrphansAndPruneStale(): InflightDirectDownload[] {
  const all = safeReadAll();
  const now = Date.now();
  const fresh = all.filter((e) => now - e.startedAt < STALE_THRESHOLD_MS);
  if (fresh.length !== all.length) {
    safeWriteAll(fresh);
  }
  return fresh;
}

/**
 * Clear every inflight entry. Used by the banner's "Dismiss all"
 * action when the user has multiple orphans and wants to bulk-skip.
 */
export function clearAllInflight(): void {
  safeWriteAll([]);
}
