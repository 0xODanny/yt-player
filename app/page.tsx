"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  cancelJob,
  createJob,
  getJob,
  type JobMetadata,
  type JobResponse,
  type JobStatusResponse,
} from "@/lib/apiClient";
import { hapticLibrarySaveFailure, hapticLibrarySaveSuccess } from "@/lib/haptics";
import {
  addItem,
  isLibrarySupported,
  loadManifest,
  requestPersistentStorage,
} from "@/lib/library";
import { useSettings } from "@/lib/settings";
import { videoIdFromSourceUrl } from "@/lib/search";
import { sharePepinhoApp } from "@/lib/shareApp";

import { LibraryView } from "./components/LibraryView";
import { SearchView } from "./components/SearchView";
import { SettingsPanel } from "./components/SettingsPanel";
import { TipsPanel } from "./components/TipsPanel";

type FormatOption = "mp3" | "mp4";
type QualityOption =
  | "best"
  | "1080p"
  | "720p"
  | "480p"
  | "360p"
  | "240p"
  | "144p"
  | "audio-only";

type ActiveJob = JobResponse & Partial<JobStatusResponse>;

type RecentJob = {
  id: string;
  url: string;
  format: FormatOption;
  quality: QualityOption;
  title?: string;
  thumbnail?: string;
  status: JobStatusResponse["status"] | "queued";
  downloadUrl?: string;
  createdAt: number;
};

const RECENT_JOBS_KEY = "yt-local-tool:recent-jobs";
const RECENT_JOBS_LIMIT = 6;

const formatOptions: Array<{ value: FormatOption; label: string }> = [
  { value: "mp3", label: "MP3 (audio)" },
  { value: "mp4", label: "MP4 (video)" },
];

const qualityOptions: Array<{ value: QualityOption; label: string }> = [
  { value: "best", label: "Best available" },
  { value: "1080p", label: "Up to 1080p (~150 MB / 5 min)" },
  { value: "720p", label: "Up to 720p (~80 MB / 5 min)" },
  { value: "480p", label: "Up to 480p (~60 MB / 5 min)" },
  { value: "360p", label: "Up to 360p (~50 MB / 5 min)" },
  { value: "240p", label: "Up to 240p (~25 MB / 5 min)" },
  { value: "144p", label: "Up to 144p (~12 MB / 5 min — minimum)" },
  { value: "audio-only", label: "Audio only (~5 MB / 5 min)" },
];

const DIRECT_MEDIA_EXTENSIONS = [".mp3", ".mp4", ".m4a", ".wav", ".mov", ".webm"];

function formatDuration(duration: number | null | undefined) {
  if (!duration || duration < 1) {
    return null;
  }

  const hours = Math.floor(duration / 3600);
  const minutes = Math.floor((duration % 3600) / 60);
  const seconds = duration % 60;

  if (hours > 0) {
    return [hours, minutes, seconds]
      .map((value, index) => (index === 0 ? String(value) : String(value).padStart(2, "0")))
      .join(":");
  }

  return [minutes, seconds]
    .map((value, index) => (index === 0 ? String(value) : String(value).padStart(2, "0")))
    .join(":");
}

function hasVisibleMetadata(metadata: JobMetadata | undefined) {
  if (!metadata) {
    return false;
  }

  return Boolean(
    metadata.thumbnail ||
      metadata.title ||
      metadata.author ||
      metadata.duration ||
      metadata.formats?.length,
  );
}

function isLikelyDirectMediaUrl(rawUrl: string) {
  try {
    const parsed = new URL(rawUrl);
    const pathname = parsed.pathname.toLowerCase();
    return DIRECT_MEDIA_EXTENSIONS.some((extension) => pathname.endsWith(extension));
  } catch {
    return false;
  }
}

function classifyUrl(rawUrl: string):
  | { kind: "empty" }
  | { kind: "invalid" }
  | { kind: "youtube" }
  | { kind: "direct" }
  | { kind: "generic" } {
  const trimmed = rawUrl.trim();

  if (!trimmed) {
    return { kind: "empty" };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { kind: "invalid" };
  }

  if (!(parsed.protocol === "http:" || parsed.protocol === "https:")) {
    return { kind: "invalid" };
  }

  const host = parsed.hostname.toLowerCase();
  if (host === "youtube.com" || host === "www.youtube.com" || host === "youtu.be" || host === "m.youtube.com") {
    return { kind: "youtube" };
  }

  if (isLikelyDirectMediaUrl(trimmed)) {
    return { kind: "direct" };
  }

  return { kind: "generic" };
}

function loadRecentJobs(): RecentJob[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(RECENT_JOBS_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as RecentJob[];
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.slice(0, RECENT_JOBS_LIMIT);
  } catch {
    return [];
  }
}

function persistRecentJobs(jobs: RecentJob[]) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(RECENT_JOBS_KEY, JSON.stringify(jobs.slice(0, RECENT_JOBS_LIMIT)));
  } catch {
    // ignore storage write failures
  }
}

function statusLabel(status: JobStatusResponse["status"] | undefined): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "processing":
      return "Downloading";
    case "complete":
      return "Complete";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return "Idle";
  }
}

function isJobCancellable(status: JobStatusResponse["status"] | undefined) {
  return status === "queued" || status === "processing";
}

function friendlyJobMessage(
  rawMessage: string,
  status: JobStatusResponse["status"] | undefined,
): string {
  if (!rawMessage) {
    return "";
  }

  // Most yt-dlp failure messages we care about have very recognizable substrings.
  // Translate them into something a non-technical user can act on.
  if (status === "failed") {
    const lower = rawMessage.toLowerCase();

    if (
      lower.includes("sign in to confirm") ||
      lower.includes("login_required") ||
      lower.includes("login required")
    ) {
      return "YouTube isn't letting us play this one right now — usually music videos or age-restricted ones. Try another, most still work.";
    }

    if (lower.includes("video unavailable") || lower.includes("not available in your country")) {
      return "This video isn't available (it may be region-locked or removed).";
    }

    if (lower.includes("private video")) {
      return "This video is private and can't be downloaded.";
    }

    if (lower.includes("requested format is not available")) {
      return "That quality isn't available for this video. Pick a different one.";
    }

    if (
      lower.includes("410") ||
      lower.includes("gone") ||
      lower.includes("404") ||
      lower.includes("not found")
    ) {
      return "That page is gone, removed, or the site won't let our server open it. Try Search to stream, or paste a YouTube or direct .mp4 / .mp3 link here.";
    }

    if (
      lower.includes("403") ||
      lower.includes("forbidden") ||
      lower.includes("unable to download webpage") ||
      lower.includes("http error")
    ) {
      return "The site blocked the download from our server. YouTube and direct file links (.mp4, .mp3) usually work — for other sites, try Search and tap Play instead.";
    }
  }

  // Never render anything that looks like a `user:password@host` URL
  // even if upstream forgot to scrub it. Friendly fallback.
  if (/https?:\/\/[^/\s:@]+:[^/\s@]+@/i.test(rawMessage)) {
    return "Something went wrong on our side. Please try again.";
  }

  return rawMessage;
}

function statusToneClass(status: JobStatusResponse["status"] | undefined): string {
  switch (status) {
    case "complete":
      return "success";
    case "failed":
      return "error";
    case "cancelled":
      return "idle";
    case "queued":
    case "processing":
      return "active";
    default:
      return "idle";
  }
}

type Tab = "search" | "downloader" | "library";

export default function HomePage() {
  const [tab, setTab] = useState<Tab>("search");
  const [url, setUrl] = useState("");
  const [format, setFormat] = useState<FormatOption>("mp3");
  const [quality, setQuality] = useState<QualityOption>("best");
  const [job, setJob] = useState<ActiveJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [recentJobs, setRecentJobs] = useState<RecentJob[]>([]);
  const [isOnline, setIsOnline] = useState<boolean>(true);
  const [librarySaveStatus, setLibrarySaveStatus] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [librarySaveError, setLibrarySaveError] = useState<string | null>(null);
  const [libraryReloadKey, setLibraryReloadKey] = useState(0);
  const [libraryVideoIds, setLibraryVideoIds] = useState<Set<string>>(() => new Set());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tipsOpen, setTipsOpen] = useState(false);
  const [pasteHint, setPasteHint] = useState<string | null>(null);
  const [searchDownloadActive, setSearchDownloadActive] = useState(false);
  const autoSavedJobIds = useRef<Set<string>>(new Set());
  const { settings } = useSettings();

  useEffect(() => {
    setRecentJobs(loadRecentJobs());
  }, []);

  // One-time: ask the browser to keep our OPFS data when storage is tight.
  // Required for iOS PWAs to retain the library across long periods of disuse.
  useEffect(() => {
    if (!isLibrarySupported()) {
      return;
    }
    void requestPersistentStorage();
  }, []);

  useEffect(() => {
    if (!isLibrarySupported()) {
      setLibraryVideoIds(new Set());
      return;
    }
    let cancelled = false;
    void loadManifest().then((manifest) => {
      if (cancelled) {
        return;
      }
      const ids = new Set<string>();
      for (const item of manifest.items) {
        const id = videoIdFromSourceUrl(item.sourceUrl);
        if (id) {
          ids.add(id);
        }
      }
      setLibraryVideoIds(ids);
    });
    return () => {
      cancelled = true;
    };
  }, [libraryReloadKey]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    setIsOnline(navigator.onLine);

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  const urlClassification = useMemo(() => classifyUrl(url), [url]);
  const isDirectMediaUrl = urlClassification.kind === "direct";
  const isInvalidUrl = urlClassification.kind === "invalid";

  // Auto-coerce format to mp3 for direct media URLs (worker constraint).
  useEffect(() => {
    if (isDirectMediaUrl && format !== "mp3") {
      setFormat("mp3");
    }
  }, [isDirectMediaUrl, format]);

  const upsertRecentJob = useCallback((nextJob: RecentJob) => {
    setRecentJobs((current) => {
      const filtered = current.filter((entry) => entry.id !== nextJob.id);
      const merged = [nextJob, ...filtered].slice(0, RECENT_JOBS_LIMIT);
      persistRecentJobs(merged);
      return merged;
    });
  }, []);

  const removeRecentJob = useCallback((jobId: string) => {
    setRecentJobs((current) => {
      const next = current.filter((entry) => entry.id !== jobId);
      persistRecentJobs(next);
      return next;
    });
  }, []);

  const clearRecentJobs = useCallback(() => {
    persistRecentJobs([]);
    setRecentJobs([]);
  }, []);

  /**
   * Read the OS clipboard and, if it looks like an http(s) URL, drop it into
   * the URL field. iOS PWAs surface a "Allow paste?" popup on each call to
   * navigator.clipboard.readText(), so we only call this in response to an
   * explicit user tap on the paste button.
   *
   * If `andSubmit` is true, also queue the download immediately — that's the
   * one-tap "copy link in browser, paste-and-download in PWA" flow people
   * expect from third-party iOS downloader apps.
   */
  const pasteFromClipboard = useCallback(
    async (andSubmit: boolean) => {
      setPasteHint(null);
      if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
        setPasteHint("Clipboard isn't available in this browser.");
        return;
      }

      let text = "";
      try {
        text = (await navigator.clipboard.readText()).trim();
      } catch {
        setPasteHint("Couldn't read clipboard. Allow paste in the browser prompt.");
        return;
      }

      if (!text) {
        setPasteHint("Clipboard is empty.");
        return;
      }

      const classification = classifyUrl(text);
      if (classification.kind === "invalid" || classification.kind === "empty") {
        setPasteHint("Clipboard doesn't contain a URL.");
        return;
      }

      setUrl(text);
      setTab("downloader");

      if (!andSubmit) {
        return;
      }

      setIsSubmitting(true);
      setError(null);
      setJob(null);
      setLibrarySaveStatus("idle");
      setLibrarySaveError(null);

      const directMedia = isLikelyDirectMediaUrl(text);
      const submitFormat: FormatOption = directMedia ? "mp3" : format;

      try {
        const { response, data } = await createJob({
          url: text,
          format: submitFormat,
          quality,
        });
        if (!response.ok) {
          const message = "error" in data ? data.error : undefined;
          setError(message ?? "Couldn't start the download.");
          return;
        }
        const createdJob = data as JobResponse;
        setJob({ ...createdJob, progress: 0, downloadUrl: undefined });
        upsertRecentJob({
          id: createdJob.id,
          url: text,
          format: submitFormat,
          quality,
          status: createdJob.status,
          createdAt: Date.now(),
        });
      } catch {
        setError("Couldn't connect. Check your internet and try again.");
      } finally {
        setIsSubmitting(false);
      }
    },
    [format, quality, upsertRecentJob],
  );

  useEffect(() => {
    if (
      !job?.id ||
      job.status === "complete" ||
      job.status === "failed" ||
      job.status === "cancelled"
    ) {
      return;
    }

    const jobId = job.id;
    let isCancelled = false;
    let fastPollTimer: number | null = null;

    async function refreshJobStatus() {
      try {
        const { response, data } = await getJob(jobId);

        if (!response.ok) {
          if (!isCancelled) {
            const message = "error" in data ? data.error : undefined;
            setError(message ?? "Couldn't refresh the download status.");
          }
          return;
        }

        if (!isCancelled && !("error" in data)) {
          const nextJob = data as JobStatusResponse;

          setJob((currentJob) => {
            if (!currentJob || currentJob.id !== nextJob.id) {
              return currentJob;
            }

            const merged = {
              ...currentJob,
              ...nextJob,
            } as ActiveJob;

            // Sync into recent list
            upsertRecentJob({
              id: merged.id,
              url,
              format,
              quality,
              title: merged.metadata?.title,
              thumbnail: merged.metadata?.thumbnail,
              status: merged.status,
              downloadUrl: merged.downloadUrl,
              createdAt: Date.now(),
            });

            return merged;
          });
        }
      } catch {
        if (!isCancelled) {
          setError("Lost connection. Check your internet and try again.");
        }
      }
    }

    void refreshJobStatus();
    fastPollTimer = window.setTimeout(() => {
      void refreshJobStatus();
    }, 450);

    const timerId = window.setInterval(() => {
      void refreshJobStatus();
    }, 1200);

    return () => {
      isCancelled = true;
      if (fastPollTimer !== null) {
        window.clearTimeout(fastPollTimer);
      }
      window.clearInterval(timerId);
    };
  }, [job?.id, job?.status, url, format, quality, upsertRecentJob]);

  // Auto-save completed downloads into the in-app library (OPFS).
  // Runs once per job ID once the worker reports `complete` and gives us a
  // downloadUrl. Skips if OPFS isn't supported (e.g. very old browsers).
  useEffect(() => {
    if (!job || job.status !== "complete" || !job.downloadUrl) {
      return;
    }
    if (!isLibrarySupported()) {
      return;
    }
    if (!settings.autoSaveLibrary) {
      return;
    }
    if (autoSavedJobIds.current.has(job.id)) {
      return;
    }

    autoSavedJobIds.current.add(job.id);
    let cancelled = false;

    setLibrarySaveStatus("saving");
    setLibrarySaveError(null);

    (async () => {
      try {
        const response = await fetch(job.downloadUrl as string);
        if (!response.ok) {
          throw new Error(`Download failed (${response.status}).`);
        }
        const blob = await response.blob();
        if (cancelled) {
          return;
        }
        await addItem({
          blob,
          title: job.metadata?.title || url || "Untitled",
          sourceUrl: url,
          format,
          quality,
          duration: job.metadata?.duration ?? null,
          thumbnail: job.metadata?.thumbnail,
          author: job.metadata?.author,
        });
        if (cancelled) {
          return;
        }
        setLibrarySaveStatus("saved");
        setLibraryReloadKey((current) => current + 1);
        void hapticLibrarySaveSuccess();
      } catch (err) {
        if (cancelled) {
          return;
        }
        autoSavedJobIds.current.delete(job.id);
        setLibrarySaveStatus("error");
        setLibrarySaveError(
          err instanceof Error ? err.message : "Unknown error saving to library.",
        );
        void hapticLibrarySaveFailure();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [job, url, format, quality, settings.autoSaveLibrary]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (urlClassification.kind === "empty") {
      setError("Paste a link to get started.");
      return;
    }
    if (urlClassification.kind === "invalid") {
      setError("That doesn't look like a valid link.");
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setJob(null);
    setLibrarySaveStatus("idle");
    setLibrarySaveError(null);

    try {
      const { response, data } = await createJob({ url: url.trim(), format, quality });

      if (!response.ok) {
        const message = "error" in data ? data.error : undefined;
        setError(message ?? "Couldn't start the download.");
        return;
      }

      const createdJob = data as JobResponse;

      const initialJob: ActiveJob = {
        ...createdJob,
        progress: 0,
        downloadUrl: undefined,
      };

      setJob(initialJob);

      upsertRecentJob({
        id: createdJob.id,
        url: url.trim(),
        format,
        quality,
        status: createdJob.status,
        createdAt: Date.now(),
      });
    } catch {
      setError("Couldn't connect. Check your internet and try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  /**
   * Ask the worker to kill an in-flight download. The worker stops the
   * yt-dlp child, removes any partial output file, and reports the job
   * as "cancelled" — the polling effect picks that up and stops fetching.
   * Library auto-save is gated on status === "complete" so cancelled jobs
   * never get saved.
   */
  const handleCancelJob = useCallback(
    async (jobId: string) => {
      try {
        await cancelJob(jobId);
      } catch {
        // best-effort: even if the network call fails we still update
        // the UI optimistically so the user gets feedback. Next poll
        // will reconcile if the worker actually kept running.
      }

      // Locally flip status to "cancelled" so the polling effect exits
      // and the auto-save guard short-circuits, regardless of whether
      // the worker responded.
      setJob((current) =>
        current && current.id === jobId
          ? {
              ...current,
              status: "cancelled",
              message: "Cancelled by user.",
            }
          : current,
      );

      setRecentJobs((current) => {
        const next = current.map((entry) =>
          entry.id === jobId ? { ...entry, status: "cancelled" as const } : entry,
        );
        persistRecentJobs(next);
        return next;
      });

      // Make sure we don't accidentally trigger the auto-save retry
      // path if the job had already advanced to a "complete" tick that
      // hadn't been processed yet.
      autoSavedJobIds.current.add(jobId);
    },
    [],
  );

  const reopenJob = useCallback(
    async (jobToReopen: RecentJob) => {
      setError(null);
      setUrl(jobToReopen.url);
      setFormat(jobToReopen.format);
      setQuality(jobToReopen.quality);

      try {
        const { response, data } = await getJob(jobToReopen.id);
        if (!response.ok || "error" in data) {
          const message = "error" in data ? data.error : undefined;
          setError(message ?? "Couldn't reopen this download — it may have expired.");
          return;
        }

        const liveJob = data as JobStatusResponse;
        setJob({
          id: liveJob.id,
          status: liveJob.status,
          message: liveJob.message,
          progress: liveJob.progress,
          metadata: liveJob.metadata,
          downloadUrl: liveJob.downloadUrl,
        });
      } catch {
        setError("Couldn't connect. Check your internet and try again.");
      }
    },
    [],
  );

  const metadata = job?.metadata;
  const metadataDuration = formatDuration(metadata?.duration);
  const showMetadataCard = hasVisibleMetadata(metadata);
  const progressPercent = Math.max(0, Math.min(100, job?.progress ?? 0));
  const jobProgressIndeterminate = Boolean(
    job &&
      (job.status === "queued" ||
        (job.status === "processing" && progressPercent <= 1)),
  );
  const tone = statusToneClass(job?.status);
  const hasDownload = job?.status === "complete" && Boolean(job.downloadUrl);

  const urlHelper: { tone: "muted" | "warning" | "info"; text: string } = (() => {
    switch (urlClassification.kind) {
      case "empty":
        return {
          tone: "muted",
          text: "Drop in a YouTube link or a direct media file (.mp3, .mp4, .m4a, .wav, .mov, .webm).",
        };
      case "invalid":
        return { tone: "warning", text: "That doesn't look like a valid link." };
      case "youtube":
        return { tone: "info", text: "YouTube link detected." };
      case "direct":
        return {
          tone: "info",
          text: "Direct media file detected — output is set to MP3.",
        };
      default:
        return {
          tone: "info",
          text: "Looks like a media page — we'll try to extract the audio/video.",
        };
    }
  })();

  const submitDisabled =
    isSubmitting ||
    urlClassification.kind === "empty" ||
    urlClassification.kind === "invalid";

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <img
            className="brand-mark"
            src="/icons/icon-192.png"
            alt=""
            aria-hidden
            width={32}
            height={32}
          />
          <span className="brand-text">
            <span className="brand-word-pepinho">Pepinho </span>
            <span className="brand-word-player">Player</span>
          </span>
        </div>
        <div className="topbar-meta">
          <span className={`status-dot ${isOnline ? "online" : "offline"}`} aria-hidden />
          <span className="topbar-meta-label">{isOnline ? "Online" : "Offline"}</span>
          <button
            type="button"
            className="topbar-paste"
            aria-label="Paste link and download"
            title="Paste a link from your clipboard"
            onClick={() => void pasteFromClipboard(true)}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <rect x="8" y="2" width="8" height="4" rx="1" />
              <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
              <path d="M9 14l2 2 4-4" />
            </svg>
          </button>
          <button
            type="button"
            className="topbar-tips"
            aria-label="Tips"
            title="Tips — playback, battery, and library"
            onClick={() => setTipsOpen(true)}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M9 18h6" />
              <path d="M10 22h4" />
              <path d="M12 2a7 7 0 0 0-4 12.7V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.3A7 7 0 0 0 12 2z" />
            </svg>
          </button>
          <button
            type="button"
            className="topbar-gear"
            aria-label="Settings"
            title="Settings"
            onClick={() => setSettingsOpen(true)}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </header>

      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <TipsPanel open={tipsOpen} onClose={() => setTipsOpen(false)} />

      <nav className="tab-bar" role="tablist" aria-label="Sections">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "search"}
          aria-label={
            searchDownloadActive ? "Search — download in progress" : "Search"
          }
          className={`tab${tab === "search" ? " active" : ""}`}
          onClick={() => setTab("search")}
        >
          <span>Search</span>
          {searchDownloadActive ? (
            <span className="tab-busy-dot" title="Search download in progress" aria-hidden />
          ) : null}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "downloader"}
          className={`tab${tab === "downloader" ? " active" : ""}`}
          onClick={() => setTab("downloader")}
        >
          Download
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "library"}
          className={`tab${tab === "library" ? " active" : ""}`}
          onClick={() => setTab("library")}
        >
          Library
        </button>
      </nav>

      <div hidden={tab !== "search"}>
        <SearchView
          libraryVideoIds={libraryVideoIds}
          onLibraryChanged={() => setLibraryReloadKey((current) => current + 1)}
          onSearchDownloadActiveChange={setSearchDownloadActive}
        />
      </div>

      <div hidden={tab !== "library"}>
        <LibraryView reloadKey={libraryReloadKey} />
      </div>

      {tab === "downloader" ? (
        <>
      <section className="panel">
        <form className="job-form" onSubmit={handleSubmit}>
          <label className="field">
            <span>Paste a link</span>
            <div className="input-with-clear">
              <input
                type="url"
                name="url"
                placeholder="YouTube link or direct media file"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                aria-invalid={isInvalidUrl}
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                inputMode="url"
              />
              {url ? (
                <button
                  type="button"
                  className="input-clear"
                  onClick={() => setUrl("")}
                  aria-label="Clear URL"
                  title="Clear"
                >
                  ×
                </button>
              ) : (
                <button
                  type="button"
                  className="input-paste"
                  onClick={() => void pasteFromClipboard(false)}
                  aria-label="Paste from clipboard"
                  title="Paste"
                >
                  Paste
                </button>
              )}
            </div>
            <span className={`hint hint-${urlHelper.tone}`}>{urlHelper.text}</span>
            {pasteHint ? (
              <span className="hint hint-warning" role="status">
                {pasteHint}
              </span>
            ) : null}
          </label>

          <div className="field-grid">
            <label className="field">
              <span>Format</span>
              <select
                name="format"
                value={format}
                disabled={isDirectMediaUrl}
                onChange={(event) => setFormat(event.target.value as FormatOption)}
              >
                {formatOptions.map((option) => (
                  <option
                    key={option.value}
                    value={option.value}
                    disabled={isDirectMediaUrl && option.value !== "mp3"}
                  >
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Quality</span>
              <select
                name="quality"
                value={quality}
                disabled={format === "mp3"}
                onChange={(event) => setQuality(event.target.value as QualityOption)}
              >
                {qualityOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="actions">
            <button type="submit" disabled={submitDisabled}>
              {isSubmitting ? "Starting…" : "Save to library"}
            </button>
          </div>
        </form>
      </section>

      {error || job ? (
        <section className="panel">
          <div className="section-heading">
            <h2>Download</h2>
          </div>

          {error ? (
            <div className="status-card error">
              <div className="status-row">
                <strong>Couldn't start</strong>
              </div>
              <p>{error}</p>
            </div>
          ) : job ? (
            <div className={`status-card ${tone}`}>
              <div className="status-row">
                <strong>{statusLabel(job.status)}</strong>
                <span className="status-percent">
                  {jobProgressIndeterminate ? "…" : `${progressPercent}%`}
                </span>
              </div>
              <div
                className={`progress${jobProgressIndeterminate ? " progress-indeterminate" : ""}`}
                role="progressbar"
                aria-valuenow={jobProgressIndeterminate ? undefined : progressPercent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuetext={
                  jobProgressIndeterminate ? "Download in progress" : undefined
                }
              >
                <div
                  className={`progress-bar ${tone}`}
                  style={
                    jobProgressIndeterminate
                      ? undefined
                      : { width: `${progressPercent}%` }
                  }
                />
              </div>
              {job.message ? <p>{friendlyJobMessage(job.message, job.status)}</p> : null}

              {isJobCancellable(job.status) ? (
                <div className="download-row">
                  <button
                    type="button"
                    className="cancel-button"
                    onClick={() => void handleCancelJob(job.id)}
                    title="Stop this download — nothing is saved"
                  >
                    ■ Stop
                  </button>
                  <span className="muted-text">
                    Nothing is saved if you stop now.
                  </span>
                </div>
              ) : null}

              {hasDownload && job.downloadUrl ? (
                <div className="download-row">
                  <a className="download-link" href={job.downloadUrl} download>
                    Save to device
                  </a>
                  <span
                    className={`save-status save-${librarySaveStatus}`}
                    aria-live="polite"
                  >
                    {librarySaveStatus === "saving"
                      ? "Saving…"
                      : librarySaveStatus === "saved"
                        ? "Saved"
                        : librarySaveStatus === "error"
                          ? `Couldn't save: ${librarySaveError ?? "please try again"}`
                          : ""}
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {showMetadataCard ? (
        <section className="panel">
          <div className="section-heading">
            <h2>Preview</h2>
          </div>
          <article className="metadata-card">
            {metadata?.thumbnail ? (
              <div className="metadata-thumb-wrap">
                <img
                  className="metadata-thumb"
                  src={metadata.thumbnail}
                  alt={metadata.title ? `${metadata.title} thumbnail` : "Video thumbnail"}
                />
              </div>
            ) : null}

            <div className="metadata-copy">
              {metadata?.title ? <h3>{metadata.title}</h3> : null}
              {metadata?.author ? (
                <p className="metadata-meta">Channel: {metadata.author}</p>
              ) : null}
              {metadataDuration ? (
                <p className="metadata-meta">Duration: {metadataDuration}</p>
              ) : null}
              {metadata?.formats && metadata.formats.length > 0 ? (
                <p className="metadata-meta">
                  {metadata.formats.length} stream{metadata.formats.length === 1 ? "" : "s"} available
                </p>
              ) : null}
            </div>
          </article>
        </section>
      ) : null}

      {recentJobs.length > 0 ? (
        <section className="panel recent-panel">
          <div className="section-heading">
            <h2>Recent downloads</h2>
            <button type="button" className="link-button" onClick={clearRecentJobs}>
              Clear
            </button>
          </div>

          <ul className="recent-list">
            {recentJobs.map((entry) => (
              <li key={entry.id} className={`recent-item recent-${statusToneClass(entry.status)}`}>
                <button
                  type="button"
                  className="recent-row"
                  onClick={() => void reopenJob(entry)}
                  title="Open this download again"
                >
                  {entry.thumbnail ? (
                    <img className="recent-thumb" src={entry.thumbnail} alt="" />
                  ) : (
                    <span className="recent-thumb fallback" aria-hidden>
                      {entry.format.toUpperCase()}
                    </span>
                  )}
                  <span className="recent-meta">
                    <span className="recent-title">
                      {entry.title || entry.url}
                    </span>
                    <span className="recent-sub">
                      {entry.format.toUpperCase()} · {entry.quality} · {statusLabel(entry.status)}
                    </span>
                  </span>
                </button>
                <div className="recent-actions">
                  {isJobCancellable(entry.status) ? (
                    <button
                      type="button"
                      className="recent-cancel"
                      onClick={() => void handleCancelJob(entry.id)}
                      aria-label="Stop download"
                      title="Stop download (won't save to library)"
                    >
                      ■
                    </button>
                  ) : null}
                  {entry.downloadUrl ? (
                    <a
                      className="recent-download"
                      href={entry.downloadUrl}
                      download
                      title="Download file"
                    >
                      ↓
                    </a>
                  ) : null}
                  <button
                    type="button"
                    className="recent-remove"
                    onClick={() => removeRecentJob(entry.id)}
                    aria-label="Remove from recent downloads"
                    title="Remove"
                  >
                    ×
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
        </>
      ) : null}

      <footer className="footer">
        <p className="footer-disclaimer">
          For personal use with content you own or that is in the
          public domain. Pepinho Player is provided as-is, with no
          warranties; the developer is not responsible for how it is
          used.
        </p>
        <p className="footer-meta">
          <a href="https://pepinho.lol" target="_blank" rel="noreferrer">
            pepinho.lol
          </a>
          <span className="footer-tm" title="Trademark">
            ™
          </span>
          {" · "}
          <span className="footer-meta-strong">2026</span>
          {" · "}
          <a href="mailto:hello@pepinho.lol">hello@pepinho.lol</a>
          {" · "}
          <button
            type="button"
            className="link-button footer-share footer-meta-strong"
            onClick={() => void sharePepinhoApp()}
          >
            Share app
          </button>
        </p>
      </footer>
    </main>
  );
}
