import { randomUUID } from "crypto";

import type {
  JobCreateResponse,
  JobPayload,
  JobStatusResponse,
} from "../types/jobs";

const JOB_ID_PREFIX = "job";
const QUEUED_WINDOW_MS = 2_000;
const PROCESSING_WINDOW_MS = 5_000;
const TOTAL_DURATION_MS = QUEUED_WINDOW_MS + PROCESSING_WINDOW_MS;
const MOCK_DOWNLOAD_URL = "/mock-output.txt";

export function createFakeWorkerJob(_payload: JobPayload): JobCreateResponse {
  return {
    id: createJobId(Date.now()),
    status: "queued",
    progress: 0,
    message: "Worker job accepted",
  };
}

export function getFakeWorkerJobStatus(jobId: string): JobStatusResponse {
  const createdAt = getCreatedAtFromJobId(jobId);

  if (!createdAt) {
    return {
      id: jobId,
      status: "failed",
      progress: 0,
      message: "Invalid worker job id.",
    };
  }

  const elapsedMs = Math.max(0, Date.now() - createdAt);

  if (elapsedMs < QUEUED_WINDOW_MS) {
    return {
      id: jobId,
      status: "queued",
      progress: clampProgress(Math.floor((elapsedMs / QUEUED_WINDOW_MS) * 20)),
      message: "Worker job queued.",
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
    };
  }

  return {
    id: jobId,
    status: "complete",
    progress: 100,
    message: "Worker job complete.",
    downloadUrl: MOCK_DOWNLOAD_URL,
  };
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