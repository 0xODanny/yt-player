"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  cancelJob,
  createJob,
  getJob,
  type JobPayload,
  type JobStatusResponse,
} from "@/lib/apiClient";
import { addItem, type ManifestItem } from "@/lib/library";
import {
  formatLength,
  formatViewCount,
  pickThumbnail,
  searchVideos,
  youtubeWatchUrl,
  type SearchResult,
} from "@/lib/search";
import { type SearchPreset, useSettings } from "@/lib/settings";
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
  message?: string;
};

function isStreamPreset(preset: SearchPreset): boolean {
  return preset === "stream-audio" || preset === "stream-video";
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
      return "audio stream";
    case "stream-video":
      return "video stream";
    case "mp3":
    default:
      return "MP3 audio";
  }
}

const PRESET_OPTIONS: Array<{ value: SearchPreset; label: string }> = [
  { value: "stream-audio", label: "▶ Audio" },
  { value: "stream-video", label: "▶ Video" },
  { value: "mp3", label: "↓ MP3" },
  { value: "video-144p", label: "↓ 144p" },
  { value: "video-240p", label: "↓ 240p" },
  { value: "video-360p", label: "↓ 360p" },
  { value: "video-720p", label: "↓ 720p" },
  { value: "video-1080p", label: "↓ 1080p" },
];

export function SearchView({ onLibraryChanged }: SearchViewProps) {
  const { settings, update } = useSettings();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [download, setDownload] = useState<DownloadState | null>(null);
  const [autoPlayItem, setAutoPlayItem] = useState<ManifestItem | null>(null);
  const [autoPlayStream, setAutoPlayStream] = useState<StreamSource | null>(null);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const preset = settings.searchPreset;

  // Restore persisted state on mount so iOS PWA restarts don't blank
  // out the user's search.
  useEffect(() => {
    const persisted = loadSearchState();
    if (persisted) {
      setQuery(persisted.query);
      setResults(persisted.results);
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
   * Cancel the in-flight worker download for the current result.
   * DELETE /jobs/:id makes the worker kill its yt-dlp child process,
   * unlink any partial output, and flip the job to "cancelled"; we
   * also flip our local state so the polling effect exits and the
   * single-active-download lock releases.
   */
  const handleCancelDownload = useCallback(async () => {
    const jobId = download?.jobId;
    if (jobId) {
      try {
        await cancelJob(jobId);
      } catch {
        // best-effort
      }
    }

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
    async (q: string) => {
      const trimmed = q.trim();
      if (!trimmed) {
        setResults([]);
        setSearchError(null);
        return;
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setSearching(true);
      setSearchError(null);

      try {
        const found = await searchVideos(trimmed, { signal: controller.signal });
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
            ? `Search failed: ${error.message}`
            : "Search failed.",
        );
        setResults([]);
      } finally {
        if (!controller.signal.aborted) {
          setSearching(false);
        }
      }
    },
    [pushRecentSearch],
  );

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void runSearch(query);
  }

  // When a download is in flight, poll the worker every 1.5s for status.
  useEffect(() => {
    if (!download?.jobId) {
      return;
    }
    if (
      download.status === "complete" ||
      download.status === "failed" ||
      download.status === "saving" ||
      download.status === "cancelled"
    ) {
      return;
    }

    const jobId = download.jobId;
    const videoId = download.videoId;
    let cancelled = false;

    async function poll() {
      try {
        const { response, data } = await getJob(jobId);
        if (cancelled) {
          return;
        }
        if (!response.ok || "error" in data) {
          const message = "error" in data ? data.error : undefined;
          setDownload((current) =>
            current && current.jobId === jobId
              ? { ...current, status: "failed", message: message ?? "Worker error" }
              : current,
          );
          return;
        }
        const next = data as JobStatusResponse;
        setDownload((current) =>
          current && current.jobId === jobId
            ? {
                ...current,
                status:
                  next.status === "complete"
                    ? "saving"
                    : next.status === "failed"
                      ? "failed"
                      : next.status === "queued"
                        ? "queued"
                        : "processing",
                progress: typeof next.progress === "number" ? next.progress : current.progress,
                message: next.message,
              }
            : current,
        );

        if (next.status === "complete" && next.downloadUrl) {
          // Move into "saving" state and fetch the file into the library.
          try {
            const fileResponse = await fetch(next.downloadUrl);
            if (!fileResponse.ok) {
              throw new Error(`Download failed (${fileResponse.status})`);
            }
            const blob = await fileResponse.blob();
            const result = results.find((r) => r.videoId === videoId);
            const { format } = presetToJobPayload(preset);
            const item = await addItem({
              blob,
              title: next.metadata?.title || result?.title || "Untitled",
              sourceUrl: youtubeWatchUrl(videoId),
              format,
              quality: presetLabel(preset),
              duration: next.metadata?.duration ?? result?.lengthSeconds ?? null,
              thumbnail: next.metadata?.thumbnail || pickThumbnail(result?.thumbnails ?? [], 480)?.url,
              author: next.metadata?.author || result?.author,
            });
            if (!cancelled) {
              setDownload((current) =>
                current && current.jobId === jobId
                  ? { ...current, status: "complete", progress: 100 }
                  : current,
              );
              setAutoPlayItem(item);
              onLibraryChanged();
            }
          } catch (error) {
            if (!cancelled) {
              setDownload((current) =>
                current && current.jobId === jobId
                  ? {
                      ...current,
                      status: "failed",
                      message:
                        error instanceof Error
                          ? `Save failed: ${error.message}`
                          : "Save failed.",
                    }
                  : current,
              );
            }
          }
        }
      } catch {
        if (!cancelled) {
          setDownload((current) =>
            current && current.jobId === jobId
              ? { ...current, status: "failed", message: "Network error." }
              : current,
          );
        }
      }
    }

    void poll();
    const timer = window.setInterval(() => void poll(), 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [download?.jobId, download?.status, download?.videoId, results, preset, onLibraryChanged]);

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
            message: error instanceof Error ? error.message : "Stream lookup failed.",
          });
        }
        return;
      }

      // Download path (existing behaviour).
      setDownload({
        videoId: result.videoId,
        status: "queued",
        progress: 0,
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
            message: message ?? "Worker rejected the job.",
          });
          return;
        }
        setDownload({
          videoId: result.videoId,
          jobId: (data as { id: string }).id,
          status: "queued",
          progress: 0,
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
    [download, preset, onLibraryChanged],
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
      return "YouTube blocked this download from the server. Try a different video, or set up a residential proxy / cookies.";
    }
    // Belt-and-suspenders: never render an error containing what
    // looks like a `user:password@host` URL, even if a worker layer
    // somehow missed sanitizing it. Replace with a generic message.
    if (/https?:\/\/[^/\s:@]+:[^/\s@]+@/i.test(download.message)) {
      return "Worker error (details suppressed). Check pm2 logs on the droplet for the full message.";
    }
    return download.message;
  }, [download?.message]);

  return (
    <>
      <section className="panel">
        <div className="section-heading">
          <h2>Search YouTube</h2>
          <span className="job-id">via Invidious</span>
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
                  setResults([]);
                }}
                aria-label="Clear search"
              >
                ×
              </button>
            ) : null}
          </div>

          <div className="search-presets" role="radiogroup" aria-label="Download quality">
            {PRESET_OPTIONS.map((option) => (
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
              Tap a result to download as {presetLabel(preset)} and play.
            </p>
          </div>
        </form>
      </section>

      {searchError ? (
        <section className="panel">
          <div className="status-card error">
            <div className="status-row">
              <strong>Search failed</strong>
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
                    void runSearch(q);
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

      {results.length > 0 ? (
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
              const stateLabel =
                isThis &&
                (download?.status === "queued"
                  ? "Queued"
                  : download?.status === "processing"
                    ? `Downloading ${progress}%`
                    : download?.status === "saving"
                      ? "Saving to library"
                      : download?.status === "streaming"
                        ? "Resolving stream…"
                        : download?.status === "complete"
                          ? isStreamPreset(preset) ? "Streaming" : "Saved"
                          : download?.status === "failed"
                            ? "Failed"
                            : download?.status === "cancelled"
                              ? "Cancelled"
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
                      aria-label="Stop download"
                      title="Stop download (won't save to library)"
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
                        ? "Wait for the current download to finish"
                        : `Download as ${presetLabel(preset)}`
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
                      <span className="search-title">{result.title}</span>
                      <span className="search-sub">
                        {result.author}
                        {views ? ` · ${views}` : ""}
                        {result.publishedText ? ` · ${result.publishedText}` : ""}
                      </span>
                      {isThis ? (
                        <span className={`search-state state-${download?.status}`}>
                          {stateLabel}
                          {isDownloading && progress > 0 ? (
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
