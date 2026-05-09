import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";

import { cleanupExpiredDownloads, ensureDownloadsDir, ensurePlaceholderDownload } from "./storage";
import type {
  JobCreateResponse,
  JobMetadata,
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

type StoredJobMetadata = {
  metadata: JobMetadata;
  storedAt: number;
  message?: string;
};

const jobMetadataStore = new Map<string, StoredJobMetadata>();
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
  const extractionResult = await extractJobMetadata(payload.url);

  await ensureDownloadsDir();
  await cleanupExpiredDownloads(createdAt);
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

  try {
    const filename = await ensurePlaceholderDownload(jobId, metadata);

    return {
      id: jobId,
      status: "complete",
      progress: 100,
      message: messageOverride ?? "Worker job complete.",
      metadata,
      downloadUrl: new URL(`/files/${filename}`, baseUrl).toString(),
    };
  } catch {
    return {
      id: jobId,
      status: "failed",
      progress: 0,
      message: "Unable to prepare placeholder download.",
      metadata,
    };
  }
}

export function isValidMediaSourceUrl(url: string) {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:";
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