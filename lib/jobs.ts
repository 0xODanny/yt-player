import { randomUUID } from "crypto";

import type { JobInput } from "@/lib/validators";
import type { JobStatusResponse } from "@/lib/apiClient";

export type JobRecord = JobInput & {
  id: string;
  status: "queued";
  message: "Job created";
};

const QUEUED_WINDOW_MS = 2_000;
const PROCESSING_WINDOW_MS = 5_000;
const TOTAL_DURATION_MS = QUEUED_WINDOW_MS + PROCESSING_WINDOW_MS;
const MOCK_DOWNLOAD_URL = "/mock-output.txt";
const JOB_ID_PREFIX = "job";

function clampProgress(value: number) {
  return Math.max(0, Math.min(100, value));
}

function createFakeJobId(createdAt: number) {
  return `${JOB_ID_PREFIX}_${createdAt}_${randomUUID().slice(0, 8)}`;
}

function getCreatedAtFromJobId(id: string) {
  const match = new RegExp(`^${JOB_ID_PREFIX}_(\\d+)_`).exec(id);

  if (!match) {
    return null;
  }

  const createdAt = Number(match[1]);

  if (!Number.isFinite(createdAt)) {
    return null;
  }

  return createdAt;
}

function buildQueuedStatus(id: string, elapsedMs: number): JobStatusResponse {
  const progress = clampProgress(
    Math.floor((elapsedMs / QUEUED_WINDOW_MS) * 20),
  );

  return {
    id,
    status: "queued",
    progress,
    message: "Job queued locally.",
  };
}

function buildProcessingStatus(id: string, elapsedMs: number): JobStatusResponse {
  const processingProgress = clampProgress(
    21 + Math.floor((elapsedMs / PROCESSING_WINDOW_MS) * 78),
  );

  return {
    id,
    status: "processing",
    progress: processingProgress,
    message: "Processing placeholder job locally.",
  };
}

function buildCompleteStatus(id: string): JobStatusResponse {
  return {
    id,
    status: "complete",
    progress: 100,
    message: "Mock job complete. Placeholder download is ready.",
    downloadUrl: MOCK_DOWNLOAD_URL,
  };
}

export function getFakeJobStatus(id: string): JobStatusResponse {
  const createdAt = getCreatedAtFromJobId(id);

  if (!createdAt) {
    return {
      id,
      status: "failed",
      progress: 0,
      message: "Invalid mock job id.",
    };
  }

  const elapsedMs = Math.max(0, Date.now() - createdAt);

  if (elapsedMs < QUEUED_WINDOW_MS) {
    return buildQueuedStatus(id, elapsedMs);
  }

  if (elapsedMs < TOTAL_DURATION_MS) {
    return buildProcessingStatus(id, elapsedMs - QUEUED_WINDOW_MS);
  }

  return buildCompleteStatus(id);
}

export function createFakeJob(input: JobInput): JobRecord {
  const createdAt = Date.now();
  const id = createFakeJobId(createdAt);

  return {
    id,
    status: "queued",
    message: "Job created",
    ...input,
  };
}