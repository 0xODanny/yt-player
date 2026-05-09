"use client";

import { FormEvent, useEffect, useState } from "react";

import {
  createJob,
  getJob,
  type JobMetadata,
  type JobResponse,
  type JobStatusResponse,
} from "@/lib/apiClient";

type FormatOption = "mp3" | "mp4";
type QualityOption = "best" | "1080p" | "720p" | "audio-only";

const formatOptions: Array<{ value: FormatOption; label: string }> = [
  { value: "mp3", label: "MP3" },
  { value: "mp4", label: "MP4" },
];

const qualityOptions: Array<{ value: QualityOption; label: string }> = [
  { value: "best", label: "Best" },
  { value: "1080p", label: "1080p" },
  { value: "720p", label: "720p" },
  { value: "audio-only", label: "Audio Only" },
];

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

export default function HomePage() {
  const [url, setUrl] = useState("");
  const [format, setFormat] = useState<FormatOption>("mp3");
  const [quality, setQuality] = useState<QualityOption>("best");
  const [job, setJob] = useState<(JobResponse & Partial<JobStatusResponse>) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

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

            return {
              ...currentJob,
              ...nextJob,
            };
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
  }, [job?.id, job?.status]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
    setJob(null);

    try {
      const { response, data } = await createJob({ url, format, quality });

      if (!response.ok) {
        const message = "error" in data ? data.error : undefined;
        setError(message ?? "Unable to create job.");
        return;
      }

      const createdJob = data as JobResponse;

      setJob({
        ...createdJob,
        progress: 0,
        downloadUrl: undefined,
      });
    } catch {
      setError("Network error while creating the job.");
    } finally {
      setIsSubmitting(false);
    }
  }

  const metadata = job?.metadata;
  const metadataDuration = formatDuration(metadata?.duration);
  const showMetadataCard = hasVisibleMetadata(metadata);

  return (
    <main className="shell">
      <section className="panel hero">
        <div>
          <p className="eyebrow">Local-only utility</p>
          <h1>YT Local Tool</h1>
          <p className="hero-copy">
            Phase 1 scaffold for local media jobs. This UI queues fake jobs only and
            does not download or convert anything yet.
          </p>
          <p className="hero-note">
            Private local utility interface. Processing backend not connected yet.
          </p>
        </div>
        <div className="hero-badge">App Router + TypeScript</div>
      </section>

      <section className="panel">
        <form className="job-form" onSubmit={handleSubmit}>
          <label className="field">
            <span>Video URL</span>
            <input
              type="url"
              name="url"
              placeholder="https://www.youtube.com/watch?v=..."
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>

          <div className="field-grid">
            <label className="field">
              <span>Format</span>
              <select
                name="format"
                value={format}
                onChange={(event) => setFormat(event.target.value as FormatOption)}
              >
                {formatOptions.map((option) => (
                  <option key={option.value} value={option.value}>
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
                onChange={(event) =>
                  setQuality(event.target.value as QualityOption)
                }
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
            <button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Queueing..." : "Start"}
            </button>
            <p className="helper-text">Jobs use deterministic local mock progress for polling.</p>
          </div>
        </form>
      </section>

      <section className="panel status-panel">
        <div className="section-heading">
          <h2>Status</h2>
          <span>Queue feedback</span>
        </div>

        {error ? (
          <div className="status-card error">
            <strong>Request failed</strong>
            <p>{error}</p>
          </div>
        ) : job ? (
          <div className="status-card success">
            <strong>{job.message}</strong>
            <p>Job ID: {job.id}</p>
            <p>Status: {job.status}</p>
            <p>Progress: {job.progress ?? 0}%</p>
          </div>
        ) : (
          <div className="status-card idle">
            <strong>No active request</strong>
            <p>Submit a URL to create a placeholder job.</p>
          </div>
        )}
      </section>

      {showMetadataCard ? (
        <section className="panel metadata-panel">
          <div className="section-heading">
            <h2>Metadata</h2>
            <span>Worker preview</span>
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
              {metadata?.author ? <p className="metadata-meta">Channel: {metadata.author}</p> : null}
              {metadataDuration ? <p className="metadata-meta">Duration: {metadataDuration}</p> : null}
            </div>
          </article>
        </section>
      ) : null}

      <section className="panel result-panel">
        <div className="section-heading">
          <h2>Results</h2>
          <span>Download area</span>
        </div>
        <div className="result-placeholder">
          {job?.status === "complete" && job.downloadUrl ? (
            <>
              <p>Placeholder result is ready.</p>
              <a className="download-link" href={job.downloadUrl} download>
                Download placeholder file
              </a>
            </>
          ) : (
            <>
              <p>No downloads yet.</p>
              <p>
                Future phases will expose generated files from the local downloads folder.
              </p>
            </>
          )}
        </div>
      </section>
    </main>
  );
}