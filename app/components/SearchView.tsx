"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  cancelJob,
  createJob,
  getJob,
  type JobPayload,
  type JobStatusResponse,
} from "@/lib/apiClient";
import { hapticLibrarySaveFailure, hapticLibrarySaveSuccess } from "@/lib/haptics";
import {
  clearAllInflight,
  clearInflight,
  inflightIdFor,
  registerInflight,
  takeOrphansAndPruneStale,
  type InflightDirectDownload,
} from "@/lib/inflightDownloads";
import { addItem, addItemFromStream, type ManifestItem } from "@/lib/library";
import { downloadStreamingToWritable } from "@/lib/nativeDownload";
import { isAndroidNative } from "@/lib/platform";
import {
  formatLength,
  formatViewCount,
  pickThumbnail,
  searchVideos,
  youtubeWatchUrl,
  type SearchResult,
} from "@/lib/search";
import {
  isAndroidNativeOnlyPreset,
  type SearchPreset,
  useSettings,
} from "@/lib/settings";
import { fetchStreamSource, type StreamSource } from "@/lib/stream";

import { MediaPlayer } from "./MediaPlayer";

/**
 * iOS PWAs get suspended (and frequently restarted from scratch) when the
 * user backgrounds the app or hands off to PiP. Keeping search state only
 * in React memory means everything blanks the moment they return. Mirror
 * the state into localStorage so navigating back lands them right where
 * they left off.
 */
const SEARCH_STATE_KEY = "yt-local-tool:search-state";
const RECENT_SEARCHES_KEY = "yt-local-tool:recent-searches";
const RECENT_SEARCHES_LIMIT = 8;

type PersistedSearchState = {
  query: string;
  results: SearchResult[];
};

function loadSearchState(): PersistedSearchState | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(SEARCH_STATE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as PersistedSearchState;
    if (typeof parsed.query !== "string" || !Array.isArray(parsed.results)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function saveSearchState(state: PersistedSearchState) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(SEARCH_STATE_KEY, JSON.stringify(state));
  } catch {
    // ignore quota errors
  }
}

function loadRecentSearches(): string[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(RECENT_SEARCHES_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as string[];
    return Array.isArray(parsed) ? parsed.slice(0, RECENT_SEARCHES_LIMIT) : [];
  } catch {
    return [];
  }
}

function saveRecentSearches(queries: string[]) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(
      RECENT_SEARCHES_KEY,
      JSON.stringify(queries.slice(0, RECENT_SEARCHES_LIMIT)),
    );
  } catch {
    // ignore
  }
}

type SearchViewProps = {
  onLibraryChanged: () => void;
  /** YouTube video ids already saved anywhere in the library (any folder). */
  libraryVideoIds?: ReadonlySet<string>;
};

type DownloadState = {
  videoId: string;
  jobId?: string;
  status:
    | "queued"
    | "processing"
    | "saving"
    | "streaming"
    | "complete"
    | "failed"
    | "cancelled";
  progress: number;
  /**
   * When true, show an indeterminate bar (unknown total bytes on native
   * stream save, or worker still at ~0–1% progress).
   */
  progressIndeterminate?: boolean;
  message?: string;
};

function isStreamPreset(preset: SearchPreset): boolean {
  return preset === "stream-audio" || preset === "stream-video";
}

/**
 * Friendly file-extension hint for a direct-download preset. The bytes
 * returned by yt-dlp are almost always itag 18 (MP4 with audio+video)
 * even when we asked for audio — see lib/stream.ts for the PO Token
 * fallback discussion. We still distinguish the extensions for the
 * library's "format" column so the audio-only chip lands in the
 * Library's MP3 filter and shows audio-only player chrome.
 */
function directPresetMimeAndFormat(preset: SearchPreset): {
  mime: string;
  format: "mp3" | "mp4";
} {
  if (preset === "direct-audio") {
    // The Blob still contains MP4 bytes; "mp3" here is the library's
    // logical category (audio-only), not a claim about the container.
    return { mime: "audio/mp4", format: "mp3" };
  }
  return { mime: "video/mp4", format: "mp4" };
}

function presetToJobPayload(preset: SearchPreset): {
  format: JobPayload["format"];
  quality: JobPayload["quality"];
} {
  switch (preset) {
    case "video-144p":
      return { format: "mp4", quality: "144p" };
    case "video-240p":
      return { format: "mp4", quality: "240p" };
    case "video-360p":
      return { format: "mp4", quality: "360p" };
    case "video-720p":
      return { format: "mp4", quality: "720p" };
    case "video-1080p":
      return { format: "mp4", quality: "1080p" };
    case "mp3":
    case "stream-audio":
    case "stream-video":
    // direct-* presets never reach this function (the handler short-
    // circuits before calling createJob), but exhaustiveness wants a
    // fallback so TypeScript stops bugging us.
    case "direct-audio":
    case "direct-video":
    default:
      return { format: "mp3", quality: "best" };
  }
}

function presetLabel(preset: SearchPreset): string {
  switch (preset) {
    case "video-144p":
      return "144p video";
    case "video-240p":
      return "240p video";
    case "video-360p":
      return "360p video";
    case "video-720p":
      return "720p video";
    case "video-1080p":
      return "1080p video";
    case "stream-audio":
      return "Play audio";
    case "stream-video":
      return "Play video";
    case "direct-audio":
      return "Quick audio save";
    case "direct-video":
      return "Quick video save";
    case "mp3":
    default:
      return "MP3 audio";
  }
}

type PresetOption = {
  value: SearchPreset;
  label: string;
  /**
   * When true, hide the chip unless the runtime is the Android
   * Capacitor wrapper. See lib/nativeDownload.ts for why direct-*
   * presets are platform-gated.
   */
  androidNativeOnly?: boolean;
};

const PRESET_OPTIONS: PresetOption[] = [
  { value: "stream-audio", label: "▶ Audio" },
  { value: "stream-video", label: "▶ Video" },
  { value: "mp3", label: "↓ MP3" },
  { value: "video-144p", label: "↓ 144p" },
  { value: "video-240p", label: "↓ 240p" },
  { value: "video-360p", label: "↓ 360p" },
  { value: "video-720p", label: "↓ 720p" },
  { value: "video-1080p", label: "↓ 1080p" },
  { value: "direct-audio", label: "⇣ Audio (phone data)", androidNativeOnly: true },
  { value: "direct-video", label: "⇣ Video (phone data)", androidNativeOnly: true },
];

export function SearchView({ onLibraryChanged, libraryVideoIds }: SearchViewProps) {
  const { settings, update } = useSettings();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [download, setDownload] = useState<DownloadState | null>(null);
  /** Video ids saved to the library during this browser session (Search tab). */
  const [sessionSavedVideoIds, setSessionSavedVideoIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [autoPlayItem, setAutoPlayItem] = useState<ManifestItem | null>(null);
  const [autoPlayStream, setAutoPlayStream] = useState<StreamSource | null>(null);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  // Resolve once on mount so the chip strip matches between SSR and
  // hydration. SSR always sees `false` (no Capacitor), so the
  // direct-* chips are absent in the initial markup and only appear
  // after the effect runs; that's fine because the user can't
  // interact before hydration anyway.
  const [androidNative, setAndroidNative] = useState(false);
  // Direct downloads that were running when the app was last killed.
  // Populated once on mount from localStorage (see
  // lib/inflightDownloads.ts). Rendered as a "resume?" banner above
  // the search form; entries clear as the user hits Retry / Dismiss
  // (or completes a retry successfully).
  const [orphanedDownloads, setOrphanedDownloads] = useState<
    InflightDirectDownload[]
  >([]);
  const abortRef = useRef<AbortController | null>(null);
  // Used by handleCancelDownload to abort an in-flight native
  // download (Capacitor doesn't expose true cancellation but we can
  // at least stop reporting progress and discard the staged file).
  const nativeAbortRef = useRef<AbortController | null>(null);
  /** Latest search results for the worker-job persist path (avoid stale closures + keep poll effect deps stable). */
  const resultsRef = useRef(results);
  resultsRef.current = results;
  /**
   * Bumped when the user cancels so the job-polling effect tears down its
   * interval even though jobId stays set on the cancelled download object.
   */
  const [pollGuardEpoch, setPollGuardEpoch] = useState(0);
  /** ytsearch limit (20, 40, 60…). Reset to 20 on each fresh search submit. */
  const [searchFetchLimit, setSearchFetchLimit] = useState(20);
  /**
   * While a search is in flight, how many skeleton rows to show (matches the
   * requested API limit). Cleared when the request finishes so we never flash
   * an empty list — previous results stay in state until replaced.
   */
  const [searchSkeletonRows, setSearchSkeletonRows] = useState<number | null>(null);

  useEffect(() => {
    const native = isAndroidNative();
    setAndroidNative(native);
    // Direct downloads only ever exist under the Android wrapper, so
    // there's no value showing the orphan banner on iOS/web — that
    // localStorage entry would be from a different origin anyway,
    // but guarding here lets the assertion stand for future readers.
    if (native) {
      setOrphanedDownloads(takeOrphansAndPruneStale());
    }
  }, []);

  // Filter the chip strip down to what the current platform can
  // actually do. Memoised on androidNative so the array reference is
  // stable across re-renders (cheap, but keeps React happy).
  const visiblePresets = useMemo(
    () =>
      PRESET_OPTIONS.filter(
        (option) => !option.androidNativeOnly || androidNative,
      ),
    [androidNative],
  );

  const preset = settings.searchPreset;
  const presetRef = useRef(preset);
  presetRef.current = preset;

  // Restore persisted state on mount so iOS PWA restarts don't blank
  // out the user's search.
  useEffect(() => {
    const persisted = loadSearchState();
    if (persisted) {
      setQuery(persisted.query);
      setResults(persisted.results);
      setSearchFetchLimit(Math.max(20, persisted.results.length));
    }
    setRecentSearches(loadRecentSearches());
  }, []);

  // Mirror query+results to localStorage whenever they change so we can
  // restore on next mount. Empty results are still persisted so clearing
  // a search also clears the persisted state.
  useEffect(() => {
    saveSearchState({ query, results });
  }, [query, results]);

  const pushRecentSearch = useCallback((q: string) => {
    const trimmed = q.trim();
    if (!trimmed) {
      return;
    }
    setRecentSearches((current) => {
      const filtered = current.filter(
        (entry) => entry.toLowerCase() !== trimmed.toLowerCase(),
      );
      const next = [trimmed, ...filtered].slice(0, RECENT_SEARCHES_LIMIT);
      saveRecentSearches(next);
      return next;
    });
  }, []);

  const clearRecentSearches = useCallback(() => {
    saveRecentSearches([]);
    setRecentSearches([]);
  }, []);

  /**
   * Cancel the in-flight download for the current result, whichever
   * path it's running through:
   *   - Worker job: DELETE /jobs/:id kills the yt-dlp child, unlinks
   *     any partial output, and flips the job to "cancelled".
   *   - Android-native direct download: fire the AbortController so
   *     downloadToBlob stops reporting progress and discards the
   *     staged temp file. (Capacitor 6 can't actually cut the
   *     underlying HTTP request — see the comment in
   *     lib/nativeDownload.ts — but the user-facing behaviour is the
   *     same: nothing lands in the library.)
   * Local state flips to "cancelled" so the polling effect exits and
   * the single-active-download lock releases.
   */
  const handleCancelDownload = useCallback(async () => {
    nativeAbortRef.current?.abort();
    nativeAbortRef.current = null;

    const jobId = download?.jobId;
    if (jobId) {
      try {
        await cancelJob(jobId);
      } catch {
        // best-effort
      }
    }

    setPollGuardEpoch((epoch) => epoch + 1);

    setDownload((current) =>
      current
        ? {
            ...current,
            status: "cancelled" as const,
            message: "Cancelled by user.",
          }
        : current,
    );
  }, [download?.jobId]);

  const runSearch = useCallback(
    async (q: string, limit: number) => {
      const trimmed = q.trim();
      if (!trimmed) {
        setResults([]);
        setSearchError(null);
        setSearchSkeletonRows(null);
        return;
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setSearchSkeletonRows(limit);
      setSearching(true);
      setSearchError(null);

      try {
        const found = await searchVideos(trimmed, {
          signal: controller.signal,
          limit,
        });
        if (!controller.signal.aborted) {
          setResults(found);
          if (found.length > 0) {
            pushRecentSearch(trimmed);
          }
        }
      } catch (error) {
        if ((error as Error).name === "AbortError") {
          return;
        }
        setSearchError(
          error instanceof Error
            ? `Couldn't search: ${error.message}`
            : "Couldn't search. Try again in a moment.",
        );
        // Keep prior results so the list never blanks mid-query.
      } finally {
        if (!controller.signal.aborted) {
          setSearching(false);
          setSearchSkeletonRows(null);
        }
      }
    },
    [pushRecentSearch],
  );

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearchFetchLimit(20);
    void runSearch(query, 20);
  }

  // When a download is in flight, poll the worker for status.
  // IMPORTANT: `download.status` must NOT be in the dependency array.
  // When the worker flips to complete we set status to "saving" and then
  // await fetch()+blob()+addItem(). If status were a dep, React would tear
  // this effect down mid-await, set cancelled=true, and the completion
  // handler would never run — leaving the UI stuck on "Saving…" even
  // though the file already landed in the library.
  //
  // First poll runs immediately, a second at ~450ms, then every 1200ms.
  useEffect(() => {
    if (!download?.jobId) {
      return;
    }
    if (
      download.status === "complete" ||
      download.status === "failed" ||
      download.status === "cancelled"
    ) {
      return;
    }

    const jobId = download.jobId;
    const videoId = download.videoId;
    let intervalId: number | null = null;
    let fastPollTimer: number | null = null;
    let persistInFlight = false;

    const clearTimer = () => {
      if (intervalId !== null) {
        window.clearInterval(intervalId);
        intervalId = null;
      }
      if (fastPollTimer !== null) {
        window.clearTimeout(fastPollTimer);
        fastPollTimer = null;
      }
    };

    async function poll() {
      if (persistInFlight) {
        return;
      }
      try {
        const { response, data } = await getJob(jobId);
        if (!response.ok || "error" in data) {
          const message = "error" in data ? data.error : undefined;
          void hapticLibrarySaveFailure();
          setDownload((current) =>
            current && current.jobId === jobId
              ? {
                  ...current,
                  status: "failed",
                  message: message ?? "Couldn't complete the download.",
                  progressIndeterminate: false,
                }
              : current,
          );
          clearTimer();
          return;
        }
        const next = data as JobStatusResponse;

        if (next.status === "complete" && next.downloadUrl) {
          if (persistInFlight) {
            return;
          }
          persistInFlight = true;
          clearTimer();

          setDownload((current) =>
            current && current.jobId === jobId
              ? {
                  ...current,
                  status: "saving",
                  progress: 99,
                  progressIndeterminate: true,
                  message: "Saving to library…",
                }
              : current,
          );

          try {
            const fileResponse = await fetch(next.downloadUrl);
            if (!fileResponse.ok) {
              throw new Error(`Download failed (${fileResponse.status})`);
            }
            const blob = await fileResponse.blob();
            const result = resultsRef.current.find((r) => r.videoId === videoId);
            const { format } = presetToJobPayload(presetRef.current);
            const item = await addItem({
              blob,
              title: next.metadata?.title || result?.title || "Untitled",
              sourceUrl: youtubeWatchUrl(videoId),
              format,
              quality: presetLabel(presetRef.current),
              duration: next.metadata?.duration ?? result?.lengthSeconds ?? null,
              thumbnail:
                next.metadata?.thumbnail ||
                pickThumbnail(result?.thumbnails ?? [], 480)?.url,
              author: next.metadata?.author || result?.author,
            });
            setDownload((current) =>
              current && current.jobId === jobId
                ? {
                    ...current,
                    status: "complete",
                    progress: 100,
                    progressIndeterminate: false,
                    message: undefined,
                  }
                : current,
            );
            setAutoPlayItem(item);
            onLibraryChanged();
            setSessionSavedVideoIds((prev) => new Set(prev).add(videoId));
            void hapticLibrarySaveSuccess();
          } catch (error) {
            void hapticLibrarySaveFailure();
            setDownload((current) =>
              current && current.jobId === jobId
                ? {
                    ...current,
                    status: "failed",
                    progressIndeterminate: false,
                    message:
                      error instanceof Error
                        ? `Couldn't save: ${error.message}`
                        : "Couldn't save the file.",
                  }
                : current,
            );
          }
          return;
        }

        setDownload((current) => {
          if (!current || current.jobId !== jobId) {
            return current;
          }
          const nextProgress =
            typeof next.progress === "number" ? next.progress : current.progress;
          const progressIndeterminate =
            next.status === "queued" ||
            (next.status === "processing" && nextProgress <= 1);
          return {
            ...current,
            status:
              next.status === "failed"
                ? "failed"
                : next.status === "queued"
                  ? "queued"
                  : "processing",
            progress: nextProgress,
            progressIndeterminate,
            message: next.message,
          };
        });

        if (next.status === "failed") {
          void hapticLibrarySaveFailure();
          clearTimer();
        }
      } catch {
        void hapticLibrarySaveFailure();
        setDownload((current) =>
          current && current.jobId === jobId
            ? {
                ...current,
                status: "failed",
                message: "Network error.",
                progressIndeterminate: false,
              }
            : current,
        );
        clearTimer();
      }
    }

    void poll();
    fastPollTimer = window.setTimeout(() => void poll(), 450);
    intervalId = window.setInterval(() => void poll(), 1200);
    return () => {
      clearTimer();
    };
  }, [download?.jobId, download?.videoId, pollGuardEpoch, onLibraryChanged]);

  /**
   * Run the Android-native direct-download flow for a video.
   * Extracted from handleResultTap so the orphan-recovery banner can
   * call into the same code path with metadata loaded from
   * localStorage (where we don't have a full SearchResult object).
   *
   * Side effects:
   *   - Registers an inflight entry on start, clears it on terminal
   *     state (success / abort / error). On force-kill or OOM the
   *     entry survives and surfaces as an orphan next mount.
   *   - Drives the `download` state machine identically to a
   *     fresh tap.
   *   - Wires `nativeAbortRef` so handleCancelDownload can stop it.
   */
  const executeDirectDownload = useCallback(
    async (opts: {
      videoId: string;
      title: string;
      /** Channel name. Optional because SearchResult.author is optional. */
      author?: string;
      thumbnail: string | null;
      durationSeconds: number | null;
      preset: "direct-audio" | "direct-video";
    }) => {
      const url = youtubeWatchUrl(opts.videoId);
      const streamType = opts.preset === "direct-audio" ? "audio" : "video";
      const controller = new AbortController();
      nativeAbortRef.current = controller;

      const startedAt = Date.now();
      const inflightId = inflightIdFor(opts.videoId, opts.preset, startedAt);
      registerInflight({
        id: inflightId,
        videoId: opts.videoId,
        videoTitle: opts.title,
        channelTitle: opts.author ?? "",
        thumbnail: opts.thumbnail,
        durationSeconds: opts.durationSeconds,
        preset: opts.preset,
        startedAt,
      });

      setDownload({
        videoId: opts.videoId,
        status: "queued",
        progress: 0,
        progressIndeterminate: true,
        message: "Getting ready…",
      });

      try {
        const source = await fetchStreamSource(url, streamType, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          return;
        }

        const { mime, format } = directPresetMimeAndFormat(opts.preset);
        setDownload({
          videoId: opts.videoId,
          status: "processing",
          progress: 0,
          progressIndeterminate: true,
          message: "Downloading…",
        });

        const item = await addItemFromStream({
          title: source.title || opts.title || "Untitled",
          sourceUrl: url,
          format,
          quality:
            opts.preset === "direct-audio" ? "audio (direct)" : "360p (direct)",
          duration: source.duration ?? opts.durationSeconds ?? null,
          thumbnail: source.thumbnail || opts.thumbnail || undefined,
          author: source.author || opts.author,
          writeToStream: (writable) =>
            downloadStreamingToWritable(source.url, writable, {
              filename: `${opts.videoId}.${format === "mp3" ? "m4a" : "mp4"}`,
              mimeHint: mime,
              signal: controller.signal,
              onProgress: ({ loaded, total }) => {
                const knownTotal = total != null && total > 0;
                setDownload((current) => {
                  if (!current || current.videoId !== opts.videoId) {
                    return current;
                  }
                  if (knownTotal) {
                    const pct = Math.max(
                      2,
                      Math.min(99, Math.round((loaded / total) * 100)),
                    );
                    return {
                      ...current,
                      status: "processing",
                      progress: pct,
                      progressIndeterminate: false,
                    };
                  }
                  return {
                    ...current,
                    status: "processing",
                    progress: 0,
                    progressIndeterminate: true,
                  };
                });
              },
            }),
        });

        if (controller.signal.aborted) {
          return;
        }

        setDownload((current) =>
          current && current.videoId === opts.videoId
            ? {
                ...current,
                status: "processing",
                progress: 99,
                progressIndeterminate: true,
                message: "Finishing…",
              }
            : current,
        );

        setDownload({
          videoId: opts.videoId,
          status: "complete",
          progress: 100,
          progressIndeterminate: false,
        });
        setAutoPlayItem(item);
        onLibraryChanged();
        setSessionSavedVideoIds((prev) => new Set(prev).add(opts.videoId));
        void hapticLibrarySaveSuccess();
      } catch (error) {
        if ((error as Error).name === "AbortError") {
          // Cancellation was user-initiated; the cancel handler has
          // already flipped `download` to "cancelled". Leave it.
          return;
        }
        void hapticLibrarySaveFailure();
        setDownload({
          videoId: opts.videoId,
          status: "failed",
          progress: 0,
          progressIndeterminate: false,
          message:
            error instanceof Error
              ? `Couldn't download: ${error.message}`
              : "Couldn't download. Try again in a moment.",
        });
      } finally {
        // Whether we succeeded, aborted, or failed, the in-flight
        // record served its purpose (the user is now back in front
        // of a UI that can react). Clear it so the next mount
        // doesn't see it as an orphan.
        clearInflight(inflightId);
        if (nativeAbortRef.current === controller) {
          nativeAbortRef.current = null;
        }
      }
    },
    [onLibraryChanged],
  );

  /**
   * Re-run a download that was interrupted in the previous session.
   * Removes the orphan from both component state and localStorage
   * up front so the banner row doesn't stick around after the tap,
   * then delegates to executeDirectDownload which immediately
   * registers a fresh inflight entry with a new startedAt.
   */
  const handleRetryOrphan = useCallback(
    async (orphan: InflightDirectDownload) => {
      if (
        download &&
        download.status !== "complete" &&
        download.status !== "failed" &&
        download.status !== "cancelled"
      ) {
        return; // single active job at a time
      }
      clearInflight(orphan.id);
      setOrphanedDownloads((current) =>
        current.filter((e) => e.id !== orphan.id),
      );
      await executeDirectDownload({
        videoId: orphan.videoId,
        title: orphan.videoTitle,
        author: orphan.channelTitle,
        thumbnail: orphan.thumbnail,
        durationSeconds: orphan.durationSeconds,
        preset: orphan.preset,
      });
    },
    [download, executeDirectDownload],
  );

  const handleDismissOrphan = useCallback((id: string) => {
    clearInflight(id);
    setOrphanedDownloads((current) => current.filter((e) => e.id !== id));
  }, []);

  const handleDismissAllOrphans = useCallback(() => {
    clearAllInflight();
    setOrphanedDownloads([]);
  }, []);

  const handleResultTap = useCallback(
    async (result: SearchResult) => {
      if (
        download &&
        download.status !== "complete" &&
        download.status !== "failed" &&
        download.status !== "cancelled"
      ) {
        return; // single active job at a time
      }

      const url = youtubeWatchUrl(result.videoId);

      // Direct-download path (Android Capacitor app only). Same
      // metadata round-trip as streaming (worker → IPRoyal → yt-dlp
      // returns a googlevideo.com URL), but instead of opening
      // MediaPlayer we hand the URL to native HTTP code which fetches
      // the file from the device's residential IP and stages it for
      // OPFS save. Bandwidth flow: ~50 KB through IPRoyal for
      // metadata, then ~50 MB phone↔googlevideo direct, free.
      //
      // Fallback: if we're somehow on a non-Android platform with a
      // direct-* preset selected (e.g. user manually edited
      // localStorage), degrade gracefully to a stream of the same
      // type so the tap isn't a no-op.
      if (isAndroidNativeOnlyPreset(preset)) {
        if (!androidNative) {
          const streamType = preset === "direct-audio" ? "audio" : "video";
          setDownload({
            videoId: result.videoId,
            status: "streaming",
            progress: 0,
            message: "Quick save is only in the Android app. Playing instead.",
          });
          try {
            const source = await fetchStreamSource(url, streamType);
            setAutoPlayStream({
              ...source,
              title: source.title || result.title,
              author: source.author || result.author,
              thumbnail:
                source.thumbnail ||
                pickThumbnail(result.thumbnails, 480)?.url,
            });
            setDownload({
              videoId: result.videoId,
              status: "complete",
              progress: 100,
            });
          } catch (error) {
            setDownload({
              videoId: result.videoId,
              status: "failed",
              progress: 0,
              message:
                error instanceof Error ? error.message : "Couldn't load this video.",
            });
          }
          return;
        }

        await executeDirectDownload({
          videoId: result.videoId,
          title: result.title,
          author: result.author,
          thumbnail: pickThumbnail(result.thumbnails, 480)?.url ?? null,
          durationSeconds: result.lengthSeconds ?? null,
          preset: preset as "direct-audio" | "direct-video",
        });
        return;
      }

      // Stream path: ask the worker to resolve a googlevideo.com URL we can
      // play directly, then open MediaPlayer with that URL. No download,
      // no library save, no IPRoyal bandwidth (just the tiny metadata
      // call). Ad-free because we bypass YouTube's player.
      if (isStreamPreset(preset)) {
        setDownload({
          videoId: result.videoId,
          status: "streaming",
          progress: 0,
        });
        try {
          const streamType = preset === "stream-audio" ? "audio" : "video";
          const source = await fetchStreamSource(url, streamType);
          // Augment with the search result's metadata so the player has
          // a thumbnail / author even if yt-dlp's --get-url skipped them.
          setAutoPlayStream({
            ...source,
            title: source.title || result.title,
            author: source.author || result.author,
            thumbnail:
              source.thumbnail ||
              pickThumbnail(result.thumbnails, 480)?.url,
          });
          setDownload({
            videoId: result.videoId,
            status: "complete",
            progress: 100,
          });
        } catch (error) {
          setDownload({
            videoId: result.videoId,
            status: "failed",
            progress: 0,
            message: error instanceof Error ? error.message : "Couldn't load this video.",
          });
        }
        return;
      }

      // Download path (existing behaviour).
      setDownload({
        videoId: result.videoId,
        status: "queued",
        progress: 0,
        progressIndeterminate: true,
      });

      const { format, quality } = presetToJobPayload(preset);

      try {
        const { response, data } = await createJob({ url, format, quality });
        if (!response.ok || "error" in data) {
          const message = "error" in data ? (data as { error?: string }).error : undefined;
          setDownload({
            videoId: result.videoId,
            status: "failed",
            progress: 0,
            message: message ?? "Couldn't start the download.",
          });
          return;
        }
        setDownload({
          videoId: result.videoId,
          jobId: (data as { id: string }).id,
          status: "queued",
          progress: 0,
          progressIndeterminate: true,
        });
      } catch (error) {
        setDownload({
          videoId: result.videoId,
          status: "failed",
          progress: 0,
          message: error instanceof Error ? error.message : "Network error.",
        });
      }
    },
    [download, preset, androidNative, onLibraryChanged, executeDirectDownload],
  );

  const friendlyMessage = useMemo(() => {
    if (!download?.message) {
      return null;
    }
    const lower = download.message.toLowerCase();
    if (
      lower.includes("sign in to confirm") ||
      lower.includes("login_required")
    ) {
      return "YouTube isn't letting us play this one right now. Try another video — most still work.";
    }
    // Never render anything that looks like a `user:password@host`
    // URL even if the server forgot to scrub it. Fall back to a
    // friendly generic message instead.
    if (/https?:\/\/[^/\s:@]+:[^/\s@]+@/i.test(download.message)) {
      return "Something went wrong on our side. Please try again.";
    }
    return download.message;
  }, [download?.message]);

  return (
    <>
      {orphanedDownloads.length > 0 ? (
        <section className="panel">
          <div className="section-heading">
            <h2>
              Interrupted download{orphanedDownloads.length > 1 ? "s" : ""}
            </h2>
            {orphanedDownloads.length > 1 ? (
              <button
                type="button"
                className="link-button"
                onClick={handleDismissAllOrphans}
              >
                Dismiss all
              </button>
            ) : null}
          </div>
          <p className="muted-text" style={{ marginTop: 0 }}>
            These downloads were still in progress when the app closed.
            Tap Retry to try them again, or Dismiss to forget.
          </p>
          <ul className="orphan-list">
            {orphanedDownloads.map((orphan) => {
              const ageMin = Math.max(
                1,
                Math.round((Date.now() - orphan.startedAt) / 60000),
              );
              return (
                <li key={orphan.id} className="orphan-row">
                  {orphan.thumbnail ? (
                    <img
                      className="search-thumb"
                      src={orphan.thumbnail}
                      alt=""
                      loading="lazy"
                    />
                  ) : (
                    <span className="search-thumb fallback" aria-hidden>
                      ⇣
                    </span>
                  )}
                  <span className="search-meta">
                    <span className="search-title">{orphan.videoTitle}</span>
                    <span className="search-sub">
                      {orphan.channelTitle}
                      {" · "}
                      {orphan.preset === "direct-audio"
                        ? "audio"
                        : "video"}
                      {" · "}
                      {ageMin}m ago
                    </span>
                  </span>
                  <span className="orphan-actions">
                    <button
                      type="button"
                      onClick={() => void handleRetryOrphan(orphan)}
                      disabled={
                        download != null &&
                        download.status !== "complete" &&
                        download.status !== "failed" &&
                        download.status !== "cancelled"
                      }
                    >
                      Retry
                    </button>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => handleDismissOrphan(orphan.id)}
                    >
                      Dismiss
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section className="panel">
        <div className="section-heading">
          <h2>Search</h2>
        </div>

        <form className="search-form" onSubmit={handleSubmit}>
          <div className="input-with-clear search-input">
            <input
              type="search"
              value={query}
              placeholder="Search videos, songs, channels…"
              onChange={(event) => setQuery(event.target.value)}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              enterKeyHint="search"
              inputMode="search"
            />
            {query ? (
              <button
                type="button"
                className="input-clear"
                onClick={() => {
                  setQuery("");
                  abortRef.current?.abort();
                  setSearching(false);
                  setSearchSkeletonRows(null);
                  setResults([]);
                }}
                aria-label="Clear search"
              >
                ×
              </button>
            ) : null}
          </div>

          <div className="search-presets" role="radiogroup" aria-label="Download quality">
            {visiblePresets.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={preset === option.value}
                className={`folder-chip${preset === option.value ? " active" : ""}`}
                onClick={() => update("searchPreset", option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>

          <div className="actions">
            <button type="submit" disabled={searching || !query.trim()}>
              {searching ? "Searching…" : "Search"}
            </button>
            <p className="helper-text">
              {isStreamPreset(preset)
                ? `Tap a result to play it ad-free.`
                : isAndroidNativeOnlyPreset(preset)
                  ? `Tap a result to save it to your library. The download uses your phone's data. You can lock the screen — closing the app will pause it (you'll see a Resume prompt next time).`
                  : `Tap a result to save it to your library as ${presetLabel(preset)}.`}
            </p>
          </div>
        </form>
      </section>

      {searchError ? (
        <section className="panel">
          <div className="status-card error">
            <div className="status-row">
              <strong>Couldn't search</strong>
            </div>
            <p>{searchError}</p>
          </div>
        </section>
      ) : null}

      {recentSearches.length > 0 && results.length === 0 && !searching ? (
        <section className="panel">
          <div className="section-heading">
            <h2>Recent searches</h2>
            <button type="button" className="link-button" onClick={clearRecentSearches}>
              Clear
            </button>
          </div>
          <ul className="recent-searches">
            {recentSearches.map((q) => (
              <li key={q}>
                <button
                  type="button"
                  className="recent-search-chip"
                  onClick={() => {
                    setQuery(q);
                    setSearchFetchLimit(20);
                    void runSearch(q, 20);
                  }}
                  title={`Search "${q}" again`}
                >
                  {q}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {searching && query.trim() && searchSkeletonRows !== null ? (
        <section className="panel" aria-busy="true" aria-live="polite">
          <div className="section-heading">
            <h2>Results</h2>
            <span className="job-id muted-text">Searching…</span>
          </div>
          <ul className="search-list">
            {Array.from({ length: searchSkeletonRows }, (_, i) => (
              <li
                key={`search-sk-${i}`}
                className="search-item search-item-skeleton"
                aria-hidden
              >
                <div className="search-row search-row-skeleton">
                  <span className="search-thumb search-skeleton-thumb" />
                  <span className="search-meta search-skeleton-meta">
                    <span className="search-skeleton-line search-skeleton-title" />
                    <span className="search-skeleton-line search-skeleton-sub" />
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : results.length > 0 ? (
        <section className="panel">
          <div className="section-heading">
            <h2>Results</h2>
            <span className="job-id">{results.length} videos</span>
          </div>

          <ul className="search-list">
            {results.map((result) => {
              const thumb = pickThumbnail(result.thumbnails, 360);
              const length = formatLength(result.lengthSeconds);
              const views = formatViewCount(result.viewCount);
              const isThis = download?.videoId === result.videoId;
              const isTerminal =
                download?.status === "complete" ||
                download?.status === "failed" ||
                download?.status === "cancelled";
              const otherActive =
                download &&
                download.videoId !== result.videoId &&
                !isTerminal;
              const isDownloading = isThis && !isTerminal;
              const progress = isThis ? Math.round(download?.progress ?? 0) : 0;
              const progressIndeterminate = Boolean(
                isThis && download?.progressIndeterminate,
              );
              const stateLabel =
                isThis &&
                (download?.status === "queued"
                  ? "Starting…"
                  : download?.status === "processing"
                    ? progressIndeterminate
                      ? "Downloading…"
                      : `Downloading ${progress}%`
                    : download?.status === "saving"
                      ? "Saving…"
                      : download?.status === "streaming"
                        ? "Loading…"
                        : download?.status === "complete"
                          ? isStreamPreset(preset) ? "Playing" : "Saved"
                          : download?.status === "failed"
                            ? "Failed"
                            : download?.status === "cancelled"
                              ? "Stopped"
                              : "");
              const canCancel =
                isThis &&
                (download?.status === "queued" || download?.status === "processing");
              return (
                <li key={result.videoId} className="search-item">
                  {canCancel ? (
                    <button
                      type="button"
                      className="search-cancel"
                      onClick={() => void handleCancelDownload()}
                      aria-label="Stop"
                      title="Stop — nothing is saved"
                    >
                      ■
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="search-row"
                    onClick={() => void handleResultTap(result)}
                    disabled={Boolean(otherActive) || isDownloading}
                    title={
                      otherActive
                        ? "Wait for the current one to finish"
                        : presetLabel(preset)
                    }
                  >
                    {thumb ? (
                      <img
                        className="search-thumb"
                        src={thumb.url}
                        alt=""
                        loading="lazy"
                      />
                    ) : (
                      <span className="search-thumb fallback" aria-hidden>
                        ▶
                      </span>
                    )}
                    {length ? (
                      <span className="search-duration">{length}</span>
                    ) : null}
                    <span className="search-meta">
                      <span className="search-title">
                        {result.title}
                        {libraryVideoIds?.has(result.videoId) ? (
                          <span className="search-in-library">In library</span>
                        ) : sessionSavedVideoIds.has(result.videoId) ? (
                          <span className="search-session-saved">Added this session</span>
                        ) : null}
                      </span>
                      <span className="search-sub">
                        {result.author}
                        {views ? ` · ${views}` : ""}
                        {result.publishedText ? ` · ${result.publishedText}` : ""}
                      </span>
                      {isThis ? (
                        <span className={`search-state state-${download?.status}`}>
                          {stateLabel}
                          {isDownloading && progressIndeterminate ? (
                            <span
                              className="search-progress search-progress-indeterminate"
                              aria-hidden
                            >
                              <span className="search-progress-fill" />
                            </span>
                          ) : isDownloading && progress > 0 && !progressIndeterminate ? (
                            <span className="search-progress">
                              <span
                                className="search-progress-fill"
                                style={{ width: `${Math.max(2, progress)}%` }}
                              />
                            </span>
                          ) : null}
                        </span>
                      ) : null}
                      {isThis && download?.status === "failed" && friendlyMessage ? (
                        <span className="search-state-error">{friendlyMessage}</span>
                      ) : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {query.trim() &&
          results.length > 0 &&
          results.length >= searchFetchLimit &&
          searchFetchLimit < 50 ? (
            <div className="search-more-row">
              <button
                type="button"
                className="link-button"
                disabled={searching}
                onClick={() => {
                  const next = Math.min(50, searchFetchLimit + 20);
                  setSearchFetchLimit(next);
                  void runSearch(query.trim(), next);
                }}
              >
                {searching ? "Loading…" : "Show more results"}
              </button>
              <span className="muted-text">Up to 50 per search</span>
            </div>
          ) : null}
        </section>
      ) : !searching && query.trim() && !searchError ? (
        <section className="panel">
          <div className="empty-card">
            <p>No results found.</p>
            <p className="muted-text">Try different keywords.</p>
          </div>
        </section>
      ) : null}

      <MediaPlayer
        item={autoPlayItem}
        stream={autoPlayStream}
        onClose={() => {
          setAutoPlayItem(null);
          setAutoPlayStream(null);
        }}
      />
    </>
  );
}
