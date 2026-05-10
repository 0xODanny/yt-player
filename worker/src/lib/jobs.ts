import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { open, unlink } from "fs/promises";
import path from "path";
import { promisify } from "util";

import { cleanupExpiredDownloads, DOWNLOADS_DIR, ensureDownloadsDir } from "./storage";
import type {
  JobCreateResponse,
  JobMetadata,
  JobStatus,
  JobPayload,
  JobStatusResponse,
} from "../types/jobs";

const execFileAsync = promisify(execFile);

const JOB_ID_PREFIX = "job";
const QUEUED_WINDOW_MS = 2_000;
const PROCESSING_WINDOW_MS = 5_000;
const TOTAL_DURATION_MS = QUEUED_WINDOW_MS + PROCESSING_WINDOW_MS;
const METADATA_RETENTION_MS = 15 * 60 * 1_000;
const YT_DLP_BINARY = process.env.YT_DLP_BINARY?.trim() || "yt-dlp";
const SUPPORTED_DIRECT_MEDIA_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".webm",
  ".mp3",
  ".wav",
  ".m4a",
]);

type StoredJobMetadata = {
  metadata: JobMetadata;
  storedAt: number;
  message?: string;
};

type StoredDirectDownloadJob = {
  createdAt: number;
  status: JobStatus;
  progress: number;
  message: string;
  metadata: JobMetadata;
  filename?: string;
};

const jobMetadataStore = new Map<string, StoredJobMetadata>();
const directDownloadJobStore = new Map<string, StoredDirectDownloadJob>();
const BASIC_METADATA_MESSAGE = "Detailed media formats are unavailable, but basic metadata was loaded.";

class MetadataExtractionError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "MetadataExtractionError";
  }
}

export async function createFakeWorkerJob(payload: JobPayload): Promise<JobCreateResponse> {
  const createdAt = Date.now();
  const id = createJobId(createdAt);

  await ensureDownloadsDir();
  await cleanupExpiredDownloads(createdAt);
  pruneExpiredDirectJobs(createdAt);

  if (isDirectMediaDownloadRequest(payload)) {
    const normalizedUrl = normalizeDirectMediaUrl(payload.url);
    const filename = buildDirectDownloadFilename(id, normalizedUrl);
    const metadata = buildDirectMediaMetadata(normalizedUrl);

    directDownloadJobStore.set(id, {
      createdAt,
      status: "queued",
      progress: 0,
      message: "Worker job queued.",
      metadata,
      filename,
    });

    void downloadDirectMediaJob(id, normalizedUrl, filename);

    return {
      id,
      status: "queued",
      progress: 0,
      message: "Worker job accepted",
    };
  }

  if (isDirectMediaFileUrl(payload.url) && payload.format !== "mp3") {
    throw new MetadataExtractionError(
      "Direct media downloads currently support MP3 requests only.",
      400,
    );
  }

  const extractionResult = await extractJobMetadata(payload.url);

  pruneExpiredMetadata(createdAt);
  jobMetadataStore.set(id, {
    metadata: extractionResult.metadata,
    storedAt: createdAt,
    message: extractionResult.message,
  });

  return {
    id,
    status: "queued",
    progress: 0,
    message: "Worker job accepted",
  };
}

export async function getFakeWorkerJobStatus(
  jobId: string,
  baseUrl: string,
): Promise<JobStatusResponse> {
  const directJob = directDownloadJobStore.get(jobId);

  if (directJob) {
    await cleanupExpiredDownloads();

    return {
      id: jobId,
      status: directJob.status,
      progress: directJob.progress,
      message: directJob.message,
      metadata: directJob.metadata,
      downloadUrl:
        directJob.status === "complete" && directJob.filename
          ? new URL(`/files/${directJob.filename}`, baseUrl).toString()
          : undefined,
    };
  }

  const createdAt = getCreatedAtFromJobId(jobId);
  const metadata = getStoredMetadata(jobId);
  const messageOverride = getStoredMessage(jobId);

  if (!createdAt) {
    return {
      id: jobId,
      status: "failed",
      progress: 0,
      message: messageOverride ?? "Invalid worker job id.",
      metadata,
    };
  }

  await cleanupExpiredDownloads();
  const elapsedMs = Math.max(0, Date.now() - createdAt);

  if (elapsedMs < QUEUED_WINDOW_MS) {
    return {
      id: jobId,
      status: "queued",
      progress: clampProgress(Math.floor((elapsedMs / QUEUED_WINDOW_MS) * 20)),
      message: messageOverride ?? "Worker job queued.",
      metadata,
    };
  }

  if (elapsedMs < TOTAL_DURATION_MS) {
    return {
      id: jobId,
      status: "processing",
      progress: clampProgress(
        21 + Math.floor(((elapsedMs - QUEUED_WINDOW_MS) / PROCESSING_WINDOW_MS) * 78),
      ),
      message: messageOverride ?? "Worker job processing.",
      metadata,
    };
  }

  return {
    id: jobId,
    status: "complete",
    progress: 100,
    message: messageOverride ?? "Worker job complete.",
    metadata,
  };
}

export function isValidMediaSourceUrl(url: string) {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:";
  } catch {
    return false;
  }
}

export function isDirectMediaFileUrl(url: string) {
  try {
    const parsedUrl = new URL(url);
    const extension = path.extname(parsedUrl.pathname).toLowerCase();

    return SUPPORTED_DIRECT_MEDIA_EXTENSIONS.has(extension);
  } catch {
    return false;
  }
}

export function normalizeMediaSourceUrl(url: string) {
  const parsedUrl = new URL(url);

  if (isPlaylistUrl(parsedUrl)) {
    throw new MetadataExtractionError("Playlists are not supported.", 400);
  }

  if (
    (parsedUrl.hostname === "www.youtube.com" || parsedUrl.hostname === "youtube.com") &&
    parsedUrl.pathname === "/watch"
  ) {
    const videoId = parsedUrl.searchParams.get("v");

    if (!videoId) {
      throw new MetadataExtractionError("Unable to extract metadata for this video", 400);
    }

    return `https://www.youtube.com/watch?v=${videoId}`;
  }

  if (parsedUrl.hostname === "youtu.be") {
    const videoId = parsedUrl.pathname.replace(/^\//, "");

    if (!videoId) {
      throw new MetadataExtractionError("Unable to extract metadata for this video", 400);
    }

    return `https://www.youtube.com/watch?v=${videoId}`;
  }

  return parsedUrl.toString();
}

export function isMetadataExtractionError(error: unknown): error is MetadataExtractionError {
  return error instanceof MetadataExtractionError;
}

function createJobId(createdAt: number) {
  return `${JOB_ID_PREFIX}_${createdAt}_${randomUUID().slice(0, 8)}`;
}

function getCreatedAtFromJobId(jobId: string) {
  const match = new RegExp(`^${JOB_ID_PREFIX}_(\\d+)_`).exec(jobId);

  if (!match) {
    return null;
  }

  const createdAt = Number(match[1]);

  if (!Number.isFinite(createdAt)) {
    return null;
  }

  return createdAt;
}

function clampProgress(value: number) {
  return Math.max(0, Math.min(100, value));
}

function getStoredMetadata(jobId: string): JobMetadata {
  return jobMetadataStore.get(jobId)?.metadata ?? {
    title: "Unknown media",
    duration: null,
    formats: [],
  };
}

function getStoredMessage(jobId: string) {
  return jobMetadataStore.get(jobId)?.message;
}

function pruneExpiredMetadata(now: number) {
  for (const [jobId, record] of jobMetadataStore.entries()) {
    if (now - record.storedAt > METADATA_RETENTION_MS) {
      jobMetadataStore.delete(jobId);
    }
  }
}

function pruneExpiredDirectJobs(now: number) {
  for (const [jobId, record] of directDownloadJobStore.entries()) {
    if (now - record.createdAt > METADATA_RETENTION_MS) {
      directDownloadJobStore.delete(jobId);
    }
  }
}

function isDirectMediaDownloadRequest(payload: JobPayload) {
  return payload.format === "mp3" && isDirectMediaFileUrl(payload.url);
}

function normalizeDirectMediaUrl(url: string) {
  const parsedUrl = new URL(url);

  if (isYouTubeHost(parsedUrl.hostname)) {
    throw new MetadataExtractionError(
      "Direct media downloading does not support YouTube URLs.",
      400,
    );
  }

  const extension = path.extname(parsedUrl.pathname).toLowerCase();

  if (!SUPPORTED_DIRECT_MEDIA_EXTENSIONS.has(extension)) {
    throw new MetadataExtractionError(
      "Direct media URL must end with a supported file extension.",
      400,
    );
  }

  return parsedUrl.toString();
}

function buildDirectDownloadFilename(jobId: string, url: string) {
  const extension = path.extname(new URL(url).pathname).toLowerCase() || ".bin";
  const safeJobId = jobId.replace(/[^a-zA-Z0-9_-]/g, "_");

  return `${safeJobId}${extension}`;
}

function buildDirectMediaMetadata(url: string): JobMetadata {
  const parsedUrl = new URL(url);
  const filename = decodeURIComponent(path.basename(parsedUrl.pathname)) || "Direct media file";

  return {
    title: filename,
    duration: null,
    formats: [],
  };
}

async function downloadDirectMediaJob(jobId: string, normalizedUrl: string, filename: string) {
  const filePath = path.join(DOWNLOADS_DIR, filename);
  let fileHandle: Awaited<ReturnType<typeof open>> | null = null;

  try {
    updateDirectDownloadJob(jobId, {
      status: "processing",
      progress: 1,
      message: "Worker job processing.",
    });

    const response = await fetch(normalizedUrl);

    if (!response.ok || !response.body) {
      throw new Error("Direct media request failed.");
    }

    const totalBytes = Number(response.headers.get("content-length") ?? "0");
    const reader = response.body.getReader();
    fileHandle = await open(filePath, "w");
    let downloadedBytes = 0;
    let fallbackProgress = 25;

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      await fileHandle.write(value);
      downloadedBytes += value.byteLength;

      if (totalBytes > 0) {
        updateDirectDownloadJob(jobId, {
          status: "processing",
          progress: clampProgress(Math.min(99, Math.floor((downloadedBytes / totalBytes) * 100))),
          message: "Worker job processing.",
        });
      } else {
        fallbackProgress = Math.min(95, fallbackProgress + 10);
        updateDirectDownloadJob(jobId, {
          status: "processing",
          progress: fallbackProgress,
          message: "Worker job processing.",
        });
      }
    }

    await fileHandle.close();
    fileHandle = null;

    updateDirectDownloadJob(jobId, {
      status: "complete",
      progress: 100,
      message: "Worker job complete.",
    });
  } catch {
    if (fileHandle) {
      await fileHandle.close().catch(() => undefined);
    }

    await unlink(filePath).catch(() => undefined);
    updateDirectDownloadJob(jobId, {
      status: "failed",
      progress: 0,
      message: "Unable to download direct media file.",
    });
  }
}

function updateDirectDownloadJob(
  jobId: string,
  updates: Partial<StoredDirectDownloadJob>,
) {
  const currentJob = directDownloadJobStore.get(jobId);

  if (!currentJob) {
    return;
  }

  directDownloadJobStore.set(jobId, {
    ...currentJob,
    ...updates,
  });
}

async function extractJobMetadata(url: string): Promise<{
  metadata: JobMetadata;
  message?: string;
}> {
  const normalizedUrl = normalizeMediaSourceUrl(url);

  try {
    const { stdout } = await execFileAsync(YT_DLP_BINARY, [
      "--dump-json",
      "--no-playlist",
      normalizedUrl,
    ]);

    const info = JSON.parse(stdout) as YtDlpVideoInfo;

    if (Array.isArray(info.entries)) {
      throw new MetadataExtractionError("Playlists are not supported.", 400);
    }

    return {
      metadata: {
        title: info.title || "Unknown media",
        duration: Number.isFinite(Number(info.duration))
          ? Number(info.duration)
          : null,
        formats: (info.formats ?? []).map((format) => ({
          itag: Number.isFinite(Number(format.format_id)) ? Number(format.format_id) : 0,
          container: format.ext ?? "unknown",
          quality: format.format_note ?? format.resolution ?? format.format ?? "unknown",
          hasAudio: format.acodec !== "none",
          hasVideo: format.vcodec !== "none",
        })),
        thumbnail: info.thumbnail,
      },
    };
  } catch (error) {
    if (error instanceof MetadataExtractionError) {
      throw error;
    }

    const fallbackMetadata = await extractOEmbedMetadata(normalizedUrl);

    return {
      metadata: fallbackMetadata,
      message: BASIC_METADATA_MESSAGE,
    };
  }
}

function isPlaylistUrl(url: URL) {
  return Boolean(url.searchParams.get("list")) || url.pathname === "/playlist";
}

function isYouTubeHost(hostname: string) {
  return hostname === "youtube.com" || hostname === "www.youtube.com" || hostname === "youtu.be";
}

type YtDlpVideoFormat = {
  format_id?: string | number;
  ext?: string;
  format_note?: string;
  resolution?: string;
  format?: string;
  acodec?: string;
  vcodec?: string;
};

type YtDlpVideoInfo = {
  title?: string;
  duration?: number | string;
  thumbnail?: string;
  formats?: YtDlpVideoFormat[];
  entries?: unknown[];
};

type YouTubeOEmbedResponse = {
  title?: string;
  author_name?: string;
  thumbnail_url?: string;
};

async function extractOEmbedMetadata(normalizedUrl: string): Promise<JobMetadata> {
  try {
    const requestUrl = new URL("https://www.youtube.com/oembed");
    requestUrl.searchParams.set("url", normalizedUrl);
    requestUrl.searchParams.set("format", "json");

    const response = await fetch(requestUrl, {
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error("oEmbed request failed");
    }

    const data = (await response.json()) as YouTubeOEmbedResponse;

    return {
      title: data.title || "Unknown media",
      duration: null,
      formats: [],
      author: data.author_name,
      thumbnail: data.thumbnail_url,
    };
  } catch {
    throw new MetadataExtractionError(
      "Unable to extract metadata for this video",
      502,
    );
  }
}