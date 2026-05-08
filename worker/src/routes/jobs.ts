import { Router } from "express";

import { requireWorkerAuth } from "../lib/auth";
import { createFakeWorkerJob, getFakeWorkerJobStatus } from "../lib/jobs";
import type { JobPayload } from "../types/jobs";

const allowedFormats = new Set(["mp3", "mp4"]);
const allowedQualities = new Set(["best", "1080p", "720p", "audio-only"]);

const jobsRouter = Router();

jobsRouter.use(requireWorkerAuth);

jobsRouter.post("/", (request, response) => {
  const validation = validateJobPayload(request.body as Partial<JobPayload>);

  if (!validation.success) {
    response.status(400).json({ error: validation.error });
    return;
  }

  response.status(201).json(createFakeWorkerJob(validation.data));
});

jobsRouter.get("/:id", (request, response) => {
  response.json(getFakeWorkerJobStatus(request.params.id));
});

export { jobsRouter };

function validateJobPayload(payload: Partial<JobPayload>):
  | { success: true; data: JobPayload }
  | { success: false; error: string } {
  const url = payload.url?.trim();
  const format = payload.format;
  const quality = payload.quality;

  if (!url) {
    return {
      success: false as const,
      error: "URL is required.",
    };
  }

  if (!allowedFormats.has(format ?? "")) {
    return {
      success: false as const,
      error: "Format must be mp3 or mp4.",
    };
  }

  if (!allowedQualities.has(quality ?? "")) {
    return {
      success: false as const,
      error: "Quality must be one of best, 1080p, 720p, or audio-only.",
    };
  }

  const validatedFormat = format as JobPayload["format"];
  const validatedQuality = quality as JobPayload["quality"];

  return {
    success: true,
    data: {
      url,
      format: validatedFormat,
      quality: validatedQuality,
    },
  };
}