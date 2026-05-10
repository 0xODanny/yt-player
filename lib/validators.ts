const allowedFormats = new Set(["mp3", "mp4"]);
const allowedQualities = new Set([
  "best",
  "1080p",
  "720p",
  "480p",
  "360p",
  "audio-only",
]);

export type JobInput = {
  url: string;
  format: "mp3" | "mp4";
  quality: "best" | "1080p" | "720p" | "480p" | "360p" | "audio-only";
};

type ValidationResult =
  | { success: true; data: JobInput }
  | { success: false; error: string };

export function validateJobRequest(payload: {
  url?: string;
  format?: string;
  quality?: string;
}): ValidationResult {
  const url = payload.url?.trim();

  if (!url) {
    return {
      success: false,
      error: "URL is required.",
    };
  }

  const format = allowedFormats.has(payload.format ?? "") ? payload.format : "mp3";
  const quality = allowedQualities.has(payload.quality ?? "")
    ? payload.quality
    : "best";

  return {
    success: true,
    data: {
      url,
      format,
      quality,
    } as JobInput,
  };
}