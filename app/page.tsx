"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import {
  createJob,
  getJob,
  type JobMetadata,
  type JobResponse,
  type JobStatusResponse,
} from "@/lib/apiClient";

type FormatOption = "mp3" | "mp4";
type QualityOption =
  | "best"
  | "1080p"
  | "720p"
  | "480p"
  | "360p"
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
  { value: "1080p", label: "Up to 1080p" },
  { value: "720p", label: "Up to 720p" },
  { value: "480p", label: "Up to 480p (lighter)" },
  { value: "360p", label: "Up to 360p (data saver)" },
  { value: "audio-only", label: "Audio only" },
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
    default:
      return "Idle";
  }
}

function statusToneClass(status: JobStatusResponse["status"] | undefined): string {
  switch (status) {
    case "complete":
      return "success";
    case "failed":
      return "error";
    case "queued":
    case "processing":
      return "active";
    default:
      return "idle";
  }
}

export default function HomePage() {
  const [url, setUrl] = useState("");
  const [format, setFormat] = useState<FormatOption>("mp3");
  const [quality, setQuality] = useState<QualityOption>("best");
  const [job, setJob] = useState<ActiveJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [recentJobs, setRecentJobs] = useState<RecentJob[]>([]);
  const [isOnline, setIsOnline] = useState<boolean>(true);

  useEffect(() => {
    setRecentJobs(loadRecentJobs());
  }, []);

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

  useEffect(() => {
    if (!job?.id || job.status === "complete" || job.status === "failed") {
      return;
    }

    const jobId = job.id;
    let isCancelled = false;

    async function refreshJobStatus() {
      try {
        const { response, data } = await getJob(jobId);

        if (!response.ok) {
          if (!isCancelled) {
            const message = "error" in data ? data.error : undefined;
            setError(message ?? "Unable to refresh job status.");
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
          setError("Network error while fetching job status.");
        }
      }
    }

    void refreshJobStatus();

    const timerId = window.setInterval(() => {
      void refreshJobStatus();
    }, 1500);

    return () => {
      isCancelled = true;
      window.clearInterval(timerId);
    };
  }, [job?.id, job?.status, url, format, quality, upsertRecentJob]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (urlClassification.kind === "empty") {
      setError("Enter a URL to start a download.");
      return;
    }
    if (urlClassification.kind === "invalid") {
      setError("URL must be a valid http(s) link.");
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setJob(null);

    try {
      const { response, data } = await createJob({ url: url.trim(), format, quality });

      if (!response.ok) {
        const message = "error" in data ? data.error : undefined;
        setError(message ?? "Unable to create job.");
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
      setError("Network error while creating the job.");
    } finally {
      setIsSubmitting(false);
    }
  }

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
          setError(message ?? "Unable to load this past job. It may have expired.");
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
        setError("Network error while reopening this job.");
      }
    },
    [],
  );

  const metadata = job?.metadata;
  const metadataDuration = formatDuration(metadata?.duration);
  const showMetadataCard = hasVisibleMetadata(metadata);
  const progressPercent = Math.max(0, Math.min(100, job?.progress ?? 0));
  const tone = statusToneClass(job?.status);
  const hasDownload = job?.status === "complete" && Boolean(job.downloadUrl);

  const urlHelper: { tone: "muted" | "warning" | "info"; text: string } = (() => {
    switch (urlClassification.kind) {
      case "empty":
        return {
          tone: "muted",
          text: "Paste a YouTube link or a direct media file URL (.mp3, .mp4, .m4a, .wav, .mov, .webm).",
        };
      case "invalid":
        return { tone: "warning", text: "That doesn't look like a valid http(s) URL." };
      case "youtube":
        return { tone: "info", text: "YouTube source detected — yt-dlp will be used." };
      case "direct":
        return {
          tone: "info",
          text: "Direct media URL detected — output is forced to MP3 download.",
        };
      default:
        return {
          tone: "info",
          text: "Generic URL detected — yt-dlp will try to extract this source.",
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
          <span className="brand-mark" aria-hidden>YT</span>
          <span className="brand-text">YT Local Tool</span>
        </div>
        <div className="topbar-meta">
          <span className={`status-dot ${isOnline ? "online" : "offline"}`} aria-hidden />
          <span className="topbar-meta-label">{isOnline ? "Online" : "Offline"}</span>
        </div>
      </header>

      <section className="panel hero">
        <div>
          <p className="eyebrow">Local downloader</p>
          <h1>Download non-copyrighted media</h1>
          <p className="hero-copy">
            Paste a YouTube link or any direct media URL. The local worker uses{" "}
            <code>yt-dlp</code> + <code>ffmpeg</code> to fetch the media and serves the file
            back here when ready.
          </p>
        </div>
        <div className="hero-badge">PWA · App Router · TypeScript</div>
      </section>

      <section className="panel">
        <form className="job-form" onSubmit={handleSubmit}>
          <label className="field">
            <span>Video URL</span>
            <input
              type="url"
              name="url"
              placeholder="https://www.youtube.com/watch?v=... or https://example.com/clip.mp4"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              aria-invalid={isInvalidUrl}
              spellCheck={false}
            />
            <span className={`hint hint-${urlHelper.tone}`}>{urlHelper.text}</span>
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
              {isSubmitting ? "Queueing…" : "Start download"}
            </button>
            <p className="helper-text">
              Use only on content you own or that is in the public domain.
            </p>
          </div>
        </form>
      </section>

      <section className="panel status-panel">
        <div className="section-heading">
          <h2>Status</h2>
          <span>{job ? `Job ${job.id.slice(-8)}` : "No active job"}</span>
        </div>

        {error ? (
          <div className="status-card error">
            <strong>Request failed</strong>
            <p>{error}</p>
          </div>
        ) : job ? (
          <div className={`status-card ${tone}`}>
            <div className="status-row">
              <strong>{statusLabel(job.status)}</strong>
              <span className="status-percent">{progressPercent}%</span>
            </div>
            <div
              className="progress"
              role="progressbar"
              aria-valuenow={progressPercent}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className={`progress-bar ${tone}`}
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <p>{job.message}</p>
          </div>
        ) : (
          <div className="status-card idle">
            <strong>No active request</strong>
            <p>Submit a URL above to start a real worker download.</p>
          </div>
        )}
      </section>

      {showMetadataCard ? (
        <section className="panel metadata-panel">
          <div className="section-heading">
            <h2>Source preview</h2>
            <span>From worker metadata</span>
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

      <section className="panel result-panel">
        <div className="section-heading">
          <h2>Result</h2>
          <span>Download area</span>
        </div>
        <div className="result-placeholder">
          {hasDownload && job?.downloadUrl ? (
            <>
              <p>Your file is ready.</p>
              <a className="download-link" href={job.downloadUrl} download>
                Download {format.toUpperCase()} file
              </a>
            </>
          ) : job?.status === "complete" ? (
            <>
              <p>Job finished, but no download URL was returned.</p>
              <p>The worker may still be finalizing the file. Try refreshing in a moment.</p>
            </>
          ) : job?.status === "failed" ? (
            <>
              <p>The worker reported a failure for this job.</p>
              <p>{job.message}</p>
            </>
          ) : (
            <>
              <p>No file ready yet.</p>
              <p>Once the worker finishes, the download link will appear here.</p>
            </>
          )}
        </div>
      </section>

      {recentJobs.length > 0 ? (
        <section className="panel recent-panel">
          <div className="section-heading">
            <h2>Recent jobs</h2>
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
                  title="Reload this job"
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
                    aria-label="Remove from recent jobs"
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

      <footer className="footer">
        <span>YT Local Tool</span>
        <span>·</span>
        <span>Worker uses yt-dlp + ffmpeg</span>
      </footer>
    </main>
  );
}
