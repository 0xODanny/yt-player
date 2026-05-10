import { randomUUID } from "crypto";
import { execFile, spawn } from "child_process";
import { open, readdir, unlink } from "fs/promises";
import path from "path";
import { promisify } from "util";

import { cleanupExpiredDownloads, DOWNLOADS_DIR, ensureDownloadsDir } from "./storage";
import type {
  JobCreateResponse,
  JobMetadata,
  JobStatus,
  JobPayload,
  JobStatusResponse,
} from "../types/jobs";

const execFileAsync = promisify(execFile);

const JOB_ID_PREFIX = "job";
const METADATA_RETENTION_MS = 15 * 60 * 1_000;
const YT_DLP_BINARY = process.env.YT_DLP_BINARY?.trim() || "yt-dlp";
const FFMPEG_BINARY = process.env.FFMPEG_BINARY?.trim() || "ffmpeg";
// Optional cookies file (Netscape format). YouTube increasingly blocks
// datacenter IPs with "Sign in to confirm you're not a bot." A cookies file
// from a logged-in browser session bypasses that check.
const YT_DLP_COOKIES = process.env.YT_DLP_COOKIES?.trim() || "";
// Comma-separated list of YouTube player clients to try, in order. Some
// clients (web_safari, mweb, android) are less aggressively bot-checked than
// the default web client.
const YT_DLP_PLAYER_CLIENTS =
  process.env.YT_DLP_PLAYER_CLIENTS?.trim() || "web_safari,mweb,android";

// Two-hour file retention is enforced inside ./storage.
// We keep job records for the same window so the API can still answer.
const JOB_RECORD_RETENTION_MS = 2 * 60 * 60 * 1_000;

const SUPPORTED_DIRECT_MEDIA_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".webm",
  ".mp3",
  ".wav",
  ".m4a",
]);

type JobKind = "yt-dlp" | "direct";

type StoredJob = {
  kind: JobKind;
  createdAt: number;
  status: JobStatus;
  progress: number;
  message: string;
  metadata: JobMetadata;
  filename?: string;
};

const jobStore = new Map<string, StoredJob>();

const BASIC_METADATA_MESSAGE =
  "Detailed media formats are unavailable, but basic metadata was loaded.";

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

  await ensureDownloadsDir();
  await cleanupExpiredDownloads(createdAt);
  pruneExpiredJobs(createdAt);

  // Direct media file URL path (no yt-dlp)
  if (isDirectMediaDownloadRequest(payload)) {
    const normalizedUrl = normalizeDirectMediaUrl(payload.url);
    const filename = buildOutputFilename(id, path.extname(new URL(normalizedUrl).pathname));
    const metadata = buildDirectMediaMetadata(normalizedUrl);

    jobStore.set(id, {
      kind: "direct",
      createdAt,
      status: "queued",
      progress: 0,
      message: "Worker job queued.",
      metadata,
      filename,
    });

    void downloadDirectMediaJob(id, normalizedUrl, filename);

    return {
      id,
      status: "queued",
      progress: 0,
      message: "Worker job accepted",
    };
  }

  // Anything not handled by the fast direct-stream path falls through to yt-dlp,
  // which can transcode (e.g. .mp4 → mp3) and handle generic / streaming sources.
  // yt-dlp metadata + download path
  const extractionResult = await extractJobMetadata(payload.url);
  const normalizedUrl = normalizeMediaSourceUrl(payload.url);

  jobStore.set(id, {
    kind: "yt-dlp",
    createdAt,
    status: "queued",
    progress: 0,
    message: extractionResult.message ?? "Worker job queued.",
    metadata: extractionResult.metadata,
  });

  void runYtDlpDownload(id, normalizedUrl, payload);

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
  const job = jobStore.get(jobId);

  if (!job) {
    return {
      id: jobId,
      status: "failed",
      progress: 0,
      message: "Worker job is unknown or has expired.",
      metadata: { title: "Unknown media", duration: null, formats: [] },
    };
  }

  // Light cleanup on read, but never block.
  void cleanupExpiredDownloads();

  return {
    id: jobId,
    status: job.status,
    progress: job.progress,
    message: job.message,
    metadata: job.metadata,
    downloadUrl:
      job.status === "complete" && job.filename
        ? new URL(`/files/${encodeURIComponent(job.filename)}`, baseUrl).toString()
        : undefined,
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

export function isDirectMediaFileUrl(url: string) {
  try {
    const parsedUrl = new URL(url);
    const extension = path.extname(parsedUrl.pathname).toLowerCase();

    return SUPPORTED_DIRECT_MEDIA_EXTENSIONS.has(extension);
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

function clampProgress(value: number) {
  return Math.max(0, Math.min(100, value));
}

function pruneExpiredJobs(now: number) {
  for (const [jobId, record] of jobStore.entries()) {
    if (now - record.createdAt > JOB_RECORD_RETENTION_MS) {
      jobStore.delete(jobId);
    }
  }
}

/**
 * Take the fast direct-stream path only when the source URL extension already
 * matches the requested output format. Anything that needs format conversion
 * (e.g. .mp4 source + mp3 output) is routed through yt-dlp so ffmpeg does the
 * transcode correctly.
 */
function isDirectMediaDownloadRequest(payload: JobPayload) {
  if (!isDirectMediaFileUrl(payload.url)) {
    return false;
  }

  let extension: string;
  try {
    extension = path.extname(new URL(payload.url).pathname).toLowerCase();
  } catch {
    return false;
  }

  if (payload.format === "mp3") {
    return extension === ".mp3" || extension === ".m4a" || extension === ".wav";
  }

  if (payload.format === "mp4") {
    return extension === ".mp4" || extension === ".mov";
  }

  return false;
}

function normalizeDirectMediaUrl(url: string) {
  const parsedUrl = new URL(url);

  if (isYouTubeHost(parsedUrl.hostname)) {
    throw new MetadataExtractionError(
      "Direct media downloading does not support YouTube URLs.",
      400,
    );
  }

  const extension = path.extname(parsedUrl.pathname).toLowerCase();

  if (!SUPPORTED_DIRECT_MEDIA_EXTENSIONS.has(extension)) {
    throw new MetadataExtractionError(
      "Direct media URL must end with a supported file extension.",
      400,
    );
  }

  return parsedUrl.toString();
}

function buildOutputFilename(jobId: string, extension: string) {
  const safeJobId = jobId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeExt = extension && extension.startsWith(".") ? extension.toLowerCase() : ".bin";
  return `${safeJobId}${safeExt}`;
}

function buildDirectMediaMetadata(url: string): JobMetadata {
  const parsedUrl = new URL(url);
  const filename = decodeURIComponent(path.basename(parsedUrl.pathname)) || "Direct media file";

  return {
    title: filename,
    duration: null,
    formats: [],
  };
}

async function downloadDirectMediaJob(jobId: string, normalizedUrl: string, filename: string) {
  const filePath = path.join(DOWNLOADS_DIR, filename);
  let fileHandle: Awaited<ReturnType<typeof open>> | null = null;

  try {
    updateJob(jobId, {
      status: "processing",
      progress: 1,
      message: "Worker job processing.",
    });

    const response = await fetch(normalizedUrl);

    if (!response.ok || !response.body) {
      throw new Error("Direct media request failed.");
    }

    const totalBytes = Number(response.headers.get("content-length") ?? "0");
    const reader = response.body.getReader();
    fileHandle = await open(filePath, "w");
    let downloadedBytes = 0;
    let fallbackProgress = 25;

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      await fileHandle.write(value);
      downloadedBytes += value.byteLength;

      if (totalBytes > 0) {
        updateJob(jobId, {
          status: "processing",
          progress: clampProgress(Math.min(99, Math.floor((downloadedBytes / totalBytes) * 100))),
          message: "Worker job processing.",
        });
      } else {
        fallbackProgress = Math.min(95, fallbackProgress + 10);
        updateJob(jobId, {
          status: "processing",
          progress: fallbackProgress,
          message: "Worker job processing.",
        });
      }
    }

    await fileHandle.close();
    fileHandle = null;

    updateJob(jobId, {
      status: "complete",
      progress: 100,
      message: "Worker job complete.",
    });
  } catch {
    if (fileHandle) {
      await fileHandle.close().catch(() => undefined);
    }

    await unlink(filePath).catch(() => undefined);
    updateJob(jobId, {
      status: "failed",
      progress: 0,
      message: "Unable to download direct media file.",
    });
  }
}

function buildYtDlpFormatArgs(payload: JobPayload): string[] {
  const args: string[] = [];

  if (payload.format === "mp3") {
    args.push(
      "-x",
      "--audio-format",
      "mp3",
      "--audio-quality",
      "0",
    );
    return args;
  }

  if (payload.quality === "audio-only") {
    // Force mp3 audio extraction even when "format" is mp4 with "audio-only" quality.
    args.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
    return args;
  }

  // mp4 capped by quality
  const heightCap = videoQualityHeightCap(payload.quality);
  const formatSelector = heightCap
    ? `bestvideo[height<=${heightCap}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${heightCap}][ext=mp4]/best[height<=${heightCap}]`
    : "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best";

  args.push("-f", formatSelector, "--merge-output-format", "mp4");
  return args;
}

function videoQualityHeightCap(quality: JobPayload["quality"]): number | null {
  switch (quality) {
    case "1080p":
      return 1080;
    case "720p":
      return 720;
    case "480p":
      return 480;
    case "360p":
      return 360;
    default:
      return null;
  }
}

/**
 * Anti-bot / data-center friendliness flags for yt-dlp.
 * - Switches to less aggressively challenged YouTube player clients
 *   (configurable via YT_DLP_PLAYER_CLIENTS env var).
 * - Optionally passes a cookies file (YT_DLP_COOKIES env var) so YouTube
 *   sees an authenticated session, which bypasses the
 *   "Sign in to confirm you're not a bot" error common on cloud IPs.
 */
function buildYtDlpAntiBotArgs(): string[] {
  const args: string[] = [];

  if (YT_DLP_PLAYER_CLIENTS) {
    args.push(
      "--extractor-args",
      `youtube:player_client=${YT_DLP_PLAYER_CLIENTS}`,
    );
  }

  if (YT_DLP_COOKIES) {
    args.push("--cookies", YT_DLP_COOKIES);
  }

  return args;
}

async function runYtDlpDownload(jobId: string, normalizedUrl: string, payload: JobPayload) {
  // We let yt-dlp pick the final extension via `%(ext)s` so audio extraction
  // (mp3) and merged video (mp4) both end up with the right filename.
  const safeJobId = jobId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const outputTemplate = path.join(DOWNLOADS_DIR, `${safeJobId}.%(ext)s`);

  const formatArgs = buildYtDlpFormatArgs(payload);

  const args = [
    ...formatArgs,
    ...buildYtDlpAntiBotArgs(),
    "--no-playlist",
    "--no-part",
    "--no-mtime",
    "--newline",
    "--progress",
    "--no-warnings",
    "--ffmpeg-location",
    FFMPEG_BINARY,
    "-o",
    outputTemplate,
    normalizedUrl,
  ];

  updateJob(jobId, {
    status: "processing",
    progress: 1,
    message: "Worker job processing.",
  });

  const child = spawn(YT_DLP_BINARY, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderrBuffer = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    const progress = parseYtDlpProgress(trimmed);
    if (progress !== null) {
      updateJob(jobId, {
        status: "processing",
        progress: clampProgress(Math.min(99, progress)),
        message: "Worker job processing.",
      });
    }
  };

  let stdoutCarry = "";
  child.stdout.on("data", (chunk: string) => {
    const combined = stdoutCarry + chunk;
    const lines = combined.split(/\r?\n|\r/);
    stdoutCarry = lines.pop() ?? "";
    for (const line of lines) {
      handleLine(line);
    }
  });

  child.stderr.on("data", (chunk: string) => {
    stderrBuffer += chunk;
    if (stderrBuffer.length > 16_000) {
      stderrBuffer = stderrBuffer.slice(-16_000);
    }
  });

  child.on("error", () => {
    updateJob(jobId, {
      status: "failed",
      progress: 0,
      message:
        "yt-dlp is not installed on the worker. Install yt-dlp (and ffmpeg for audio/video merging).",
    });
  });

  child.on("close", async (code) => {
    if (stdoutCarry) {
      handleLine(stdoutCarry);
      stdoutCarry = "";
    }

    if (code !== 0) {
      const reason = extractYtDlpError(stderrBuffer);
      updateJob(jobId, {
        status: "failed",
        progress: 0,
        message: reason ?? "yt-dlp failed to download this media.",
      });
      return;
    }

    try {
      const filename = await findDownloadedFilename(safeJobId);

      if (!filename) {
        updateJob(jobId, {
          status: "failed",
          progress: 0,
          message: "Download finished but the output file is missing.",
        });
        return;
      }

      updateJob(jobId, {
        status: "complete",
        progress: 100,
        message: "Worker job complete.",
        filename,
      });
    } catch {
      updateJob(jobId, {
        status: "failed",
        progress: 0,
        message: "Download finished but the output file could not be located.",
      });
    }
  });
}

function parseYtDlpProgress(line: string): number | null {
  // Matches "[download]   12.3% of ..." or "100%"
  const match = /\[download\]\s+([\d.]+)%/i.exec(line);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) ? Math.floor(value) : null;
}

function extractYtDlpError(stderr: string): string | null {
  if (!stderr) {
    return null;
  }
  const lines = stderr.split(/\r?\n/).filter(Boolean);
  // Prefer the last "ERROR:" line for relevance.
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (/^error[: ]/i.test(line)) {
      return line.replace(/^error[: ]\s*/i, "").slice(0, 240);
    }
  }
  return lines[lines.length - 1]?.slice(0, 240) ?? null;
}

async function findDownloadedFilename(safeJobId: string): Promise<string | null> {
  const entries = await readdir(DOWNLOADS_DIR);
  // Prefer mp3/mp4 extensions, fall back to anything starting with the job id.
  const matches = entries.filter((entry) => entry.startsWith(`${safeJobId}.`));
  if (matches.length === 0) {
    return null;
  }

  const preferred = matches.find((entry) =>
    [".mp3", ".mp4", ".m4a", ".webm"].includes(path.extname(entry).toLowerCase()),
  );

  return preferred ?? matches[0];
}

function updateJob(jobId: string, updates: Partial<StoredJob>) {
  const current = jobStore.get(jobId);
  if (!current) {
    return;
  }

  jobStore.set(jobId, {
    ...current,
    ...updates,
  });
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
      ...buildYtDlpAntiBotArgs(),
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
        author: info.uploader || info.channel,
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

function isYouTubeHost(hostname: string) {
  return hostname === "youtube.com" || hostname === "www.youtube.com" || hostname === "youtu.be";
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
  uploader?: string;
  channel?: string;
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
