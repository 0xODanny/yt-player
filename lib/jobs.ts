import { randomUUID } from "crypto";

import type { JobInput } from "@/lib/validators";
import type { JobStatusResponse } from "@/lib/apiClient";

export type JobRecord = JobInput & {
  id: string;
  status: "queued";
  message: "Job created";
};

type StoredJobRecord = JobRecord & {
  createdAt: number;
};

const fakeJobStore = new Map<string, StoredJobRecord>();

const QUEUED_WINDOW_MS = 3_000;
const PROCESSING_WINDOW_MS = 9_000;
const MOCK_DOWNLOAD_URL = "/downloads/mock-output.txt";

function clampProgress(value: number) {
  return Math.max(0, Math.min(100, value));
}

function buildQueuedStatus(id: string): JobStatusResponse {
  return {
    id,
    status: "queued",
    progress: 8,
    message: "Job queued locally.",
  };
}

function buildProcessingStatus(id: string, elapsedMs: number): JobStatusResponse {
  const processingProgress = clampProgress(
    20 + Math.floor((elapsedMs / PROCESSING_WINDOW_MS) * 70),
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
  const job = fakeJobStore.get(id);

  if (!job) {
    return {
      id,
      status: "processing",
      progress: 50,
      message: "Mock job not found in memory. Returning placeholder progress.",
    };
  }

  const elapsedMs = Date.now() - job.createdAt;

  if (elapsedMs < QUEUED_WINDOW_MS) {
    return buildQueuedStatus(id);
  }

  if (elapsedMs < QUEUED_WINDOW_MS + PROCESSING_WINDOW_MS) {
    return buildProcessingStatus(id, elapsedMs - QUEUED_WINDOW_MS);
  }

  return buildCompleteStatus(id);
}

export function createFakeJob(input: JobInput): JobRecord {
  const id = randomUUID();
  const job: StoredJobRecord = {
    id,
    status: "queued",
    message: "Job created",
    createdAt: Date.now(),
    ...input,
  };

  fakeJobStore.set(id, job);

  return {
    id: job.id,
    status: job.status,
    message: job.message,
    url: job.url,
    format: job.format,
    quality: job.quality,
  };
}