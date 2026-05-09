import { randomUUID } from "crypto";
import ytdl from "@distube/ytdl-core";

import type {
  JobCreateResponse,
  JobMetadata,
  JobPayload,
  JobStatusResponse,
} from "../types/jobs";

const JOB_ID_PREFIX = "job";
const QUEUED_WINDOW_MS = 2_000;
const PROCESSING_WINDOW_MS = 5_000;
const TOTAL_DURATION_MS = QUEUED_WINDOW_MS + PROCESSING_WINDOW_MS;
const MOCK_DOWNLOAD_URL = "/mock-output.txt";
const METADATA_RETENTION_MS = 15 * 60 * 1_000;

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
  if (!ytdl.validateURL(url)) {
    throw new MetadataExtractionError(
      "URL is not supported for metadata extraction.",
      400,
    );
  }

  try {
    const info = await ytdl.getInfo(url);

    return {
      title: info.videoDetails.title,
      duration: Number.isFinite(Number(info.videoDetails.lengthSeconds))
        ? Number(info.videoDetails.lengthSeconds)
        : null,
      formats: info.formats.map((format) => ({
        itag: format.itag,
        container: format.container ?? "unknown",
        quality: format.qualityLabel ?? format.audioQuality ?? "unknown",
        hasAudio: Boolean(format.hasAudio),
        hasVideo: Boolean(format.hasVideo),
      })),
      thumbnail: info.videoDetails.thumbnails.at(-1)?.url,
    };
  } catch {
    throw new MetadataExtractionError(
      "Unable to extract media metadata for this URL.",
      502,
    );
  }
}