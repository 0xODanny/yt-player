export type JobFormat = "mp3" | "mp4";

export type JobQuality = "best" | "1080p" | "720p" | "audio-only";

export type JobStatus = "queued" | "processing" | "complete" | "failed";

export type JobPayload = {
  url: string;
  format: JobFormat;
  quality: JobQuality;
};

export type JobMetadataFormat = {
  itag: number;
  container: string;
  quality: string;
  hasAudio: boolean;
  hasVideo: boolean;
};

export type JobMetadata = {
  title: string;
  duration: number | null;
  formats: JobMetadataFormat[];
  author?: string;
  thumbnail?: string;
};

export type JobCreateResponse = {
  id: string;
  status: "queued";
  progress: 0;
  message: "Worker job accepted";
};

export type JobStatusResponse = {
  id: string;
  status: JobStatus;
  progress: number;
  message: string;
  metadata: JobMetadata;
  downloadUrl?: string;
};