import { Router } from "express";

import { requireWorkerAuth } from "../lib/auth";
import {
  createFakeWorkerJob,
  getFakeWorkerJobStatus,
  isMetadataExtractionError,
  isValidMediaSourceUrl,
} from "../lib/jobs";
import type { JobPayload } from "../types/jobs";

const allowedFormats = new Set(["mp3", "mp4"]);
const allowedQualities = new Set(["best", "1080p", "720p", "audio-only"]);

const jobsRouter = Router();

jobsRouter.use(requireWorkerAuth);

jobsRouter.post("/", async (request, response) => {
  const validation = validateJobPayload(request.body as Partial<JobPayload>);

  if (!validation.success) {
    response.status(400).json({ error: validation.error });
    return;
  }

  try {
    const job = await createFakeWorkerJob(validation.data);
    response.status(201).json(job);
  } catch (error) {
    if (isMetadataExtractionError(error)) {
      response.status(error.statusCode).json({ error: error.message });
      return;
    }

    response.status(500).json({ error: "Unexpected metadata extraction failure." });
  }
});

jobsRouter.get("/:id", async (request, response) => {
  const forwardedProto = request.header("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProto || request.protocol;
  const host = request.get("host") || `localhost:${process.env.PORT || 3001}`;
  const baseUrl = `${protocol}://${host}`;

  response.json(await getFakeWorkerJobStatus(request.params.id, baseUrl));
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

  if (!isValidMediaSourceUrl(url)) {
    return {
      success: false as const,
      error: "URL must be a valid http or https address.",
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