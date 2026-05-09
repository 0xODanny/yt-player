import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";

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
const MOCK_DOWNLOAD_URL = "/mock-output.txt";
const METADATA_RETENTION_MS = 15 * 60 * 1_000;
const YT_DLP_BINARY = process.env.YT_DLP_BINARY?.trim() || "yt-dlp";

type StoredJobMetadata = {
  metadata: JobMetadata;
  storedAt: number;
};

const jobMetadataStore = new Map<string, StoredJobMetadata>();

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
  const metadata = await extractJobMetadata(payload.url);

  pruneExpiredMetadata(createdAt);
  jobMetadataStore.set(id, {
    metadata,
    storedAt: createdAt,
  });

  return {
    id,
    status: "queued",
    progress: 0,
    message: "Worker job accepted",
  };
}

export function getFakeWorkerJobStatus(jobId: string): JobStatusResponse {
  const createdAt = getCreatedAtFromJobId(jobId);
  const metadata = getStoredMetadata(jobId);

  if (!createdAt) {
    return {
      id: jobId,
      status: "failed",
      progress: 0,
      message: "Invalid worker job id.",
      metadata,
    };
  }

  const elapsedMs = Math.max(0, Date.now() - createdAt);

  if (elapsedMs < QUEUED_WINDOW_MS) {
    return {
      id: jobId,
      status: "queued",
      progress: clampProgress(Math.floor((elapsedMs / QUEUED_WINDOW_MS) * 20)),
      message: "Worker job queued.",
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
      message: "Worker job processing.",
      metadata,
    };
  }

  return {
    id: jobId,
    status: "complete",
    progress: 100,
    message: "Worker job complete.",
    metadata,
    downloadUrl: MOCK_DOWNLOAD_URL,
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

function pruneExpiredMetadata(now: number) {
  for (const [jobId, record] of jobMetadataStore.entries()) {
    if (now - record.storedAt > METADATA_RETENTION_MS) {
      jobMetadataStore.delete(jobId);
    }
  }
}

async function extractJobMetadata(url: string): Promise<JobMetadata> {
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
    };
  } catch (error) {
    if (error instanceof MetadataExtractionError) {
      throw error;
    }

    throw new MetadataExtractionError(
      "Unable to extract metadata for this video",
      502,
    );
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