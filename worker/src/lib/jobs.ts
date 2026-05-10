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
// FFMPEG_BINARY: when set, we pass it through `--ffmpeg-location` so yt-dlp
// uses that exact binary. When unset, we leave the flag off entirely so
// yt-dlp does its own PATH lookup. (Passing `--ffmpeg-location ffmpeg` makes
// yt-dlp treat "ffmpeg" as a literal relative path and then fail to find it.)
const FFMPEG_BINARY = process.env.FFMPEG_BINARY?.trim() || "";
// Optional cookies file (Netscape format). YouTube increasingly blocks
// datacenter IPs with "Sign in to confirm you're not a bot." A cookies file
// from a logged-in browser session bypasses that check.
const YT_DLP_COOKIES = process.env.YT_DLP_COOKIES?.trim() || "";
// Comma-separated list of YouTube player clients to try, in order.
// Default list excludes "android" because yt-dlp logs
// `Skipping client "android" since it does not support cookies`
// the moment YT_DLP_COOKIES is set, making it dead weight in our setup.
// `web_safari`, `tv`, `mweb`, `ios` all accept cookies and historically
// have wider success against age/region/anti-datacenter checks.
const YT_DLP_PLAYER_CLIENTS =
  process.env.YT_DLP_PLAYER_CLIENTS?.trim() || "web_safari,tv,mweb,ios";
// Tell yt-dlp it's allowed to fetch the embedded JavaScript challenge solver
// components from GitHub (one-time download, then cached). Required since
// recent yt-dlp releases for YouTube's "n challenge" decryption to succeed.
// Set to an empty string to disable.
const YT_DLP_REMOTE_COMPONENTS =
  process.env.YT_DLP_REMOTE_COMPONENTS === undefined
    ? "ejs:github"
    : process.env.YT_DLP_REMOTE_COMPONENTS.trim();
// Optional outbound proxy for yt-dlp. The most reliable long-term fix for
// YouTube's anti-bot/anti-datacenter checks is routing requests through a
// residential IP. Set this to e.g.
//   http://user:pass@host:port
//   socks5://user:pass@host:port
// to have yt-dlp tunnel every request through the given proxy. Cookies stop
// being necessary for the vast majority of content once outbound traffic
// looks residential.
const YT_DLP_PROXY = process.env.YT_DLP_PROXY?.trim() || "";

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

export type WorkerSearchResult = {
  videoId: string;
  title: string;
  author?: string;
  authorId?: string;
  lengthSeconds?: number;
  viewCount?: number;
  description?: string;
  thumbnail?: string;
  publishedText?: string;
};

/**
 * Run a YouTube search through yt-dlp's `ytsearch` URL prefix. This rides on
 * our existing proxy (so the worker's flagged datacenter IP doesn't see the
 * search either) and skips the Invidious dependency entirely — public
 * Invidious instances have largely been killed by YouTube anti-abuse and
 * are no longer reliable for search.
 *
 * yt-dlp's --flat-playlist mode returns just metadata for each result rather
 * than fetching the full info JSON for each video, so a 20-result search
 * runs in 1-3 seconds instead of 20-60.
 */
export async function searchYouTube(
  query: string,
  limit = 20,
): Promise<WorkerSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }

  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit) || 20));
  const searchSpec = `ytsearch${safeLimit}:${trimmed}`;

  const args = [
    "--dump-json",
    "--flat-playlist",
    "--no-warnings",
    ...buildYtDlpAntiBotArgs(),
    searchSpec,
  ];

  let stdout = "";
  try {
    const result = await execFileAsync(YT_DLP_BINARY, args, {
      maxBuffer: 16 * 1024 * 1024,
    });
    stdout = result.stdout ?? "";
  } catch (error) {
    // yt-dlp can write valid JSON lines to stdout AND error out at the end
    // (e.g. one entry failed). Surface partial results when possible.
    const child = error as { stdout?: string };
    if (child && typeof child.stdout === "string" && child.stdout.length > 0) {
      stdout = child.stdout;
    } else {
      throw error;
    }
  }

  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);

  const results: WorkerSearchResult[] = [];
  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const id = String(entry.id ?? entry.video_id ?? "").trim();
    const title = String(entry.title ?? "").trim();
    if (!id || !title) {
      continue;
    }

    const duration =
      typeof entry.duration === "number"
        ? Math.round(entry.duration)
        : typeof entry.duration === "string"
          ? Number(entry.duration) || undefined
          : undefined;

    const viewCount =
      typeof entry.view_count === "number" ? entry.view_count : undefined;

    const thumbnail =
      typeof entry.thumbnail === "string"
        ? entry.thumbnail
        : `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

    results.push({
      videoId: id,
      title,
      author:
        typeof entry.uploader === "string"
          ? entry.uploader
          : typeof entry.channel === "string"
            ? entry.channel
            : undefined,
      authorId:
        typeof entry.channel_id === "string" ? entry.channel_id : undefined,
      lengthSeconds: duration,
      viewCount,
      description:
        typeof entry.description === "string" ? entry.description : undefined,
      thumbnail,
    });
  }

  return results;
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

  // For MP3, try bestaudio first (highest quality) but fall back through
  // itag 18 (the legacy 360p MP4 with baked-in AAC audio). YouTube gates
  // audio-only DASH streams more aggressively than the bundled itag 18 —
  // music-label uploads and anything with PRO claims often refuse the
  // bestaudio fetch but happily serve itag 18, since that format predates
  // the audio/video split and goes through the permissive legacy path.
  // ffmpeg then strips the audio track and re-encodes to mp3, so the
  // quality difference is negligible (~96-128 kbps AAC source either way).
  if (payload.format === "mp3" || payload.quality === "audio-only") {
    args.push(
      "-f",
      "bestaudio[ext=m4a]/bestaudio/18/best[ext=mp4]/best",
      "-x",
      "--audio-format",
      "mp3",
      "--audio-quality",
      "0",
    );
    return args;
  }

  // mp4 capped by quality. The trailing `best[height<=N]` branch is what
  // catches itag 18 on stubborn videos; do not remove it.
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
    case "240p":
      return 240;
    case "144p":
      return 144;
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
 * - Optionally tunnels every request through a proxy (YT_DLP_PROXY env
 *   var). Pointing this at a residential proxy is the most reliable
 *   long-term fix and makes the cookies file effectively optional.
 */
function buildYtDlpAntiBotArgs(): string[] {
  const args: string[] = [];

  if (YT_DLP_PROXY) {
    args.push("--proxy", YT_DLP_PROXY);
  }

  if (YT_DLP_PLAYER_CLIENTS) {
    args.push(
      "--extractor-args",
      `youtube:player_client=${YT_DLP_PLAYER_CLIENTS}`,
    );
  }

  if (YT_DLP_COOKIES) {
    args.push("--cookies", YT_DLP_COOKIES);
  }

  if (YT_DLP_REMOTE_COMPONENTS) {
    args.push("--remote-components", YT_DLP_REMOTE_COMPONENTS);
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
    // Retry transient failures during the actual byte-stream download.
    // YouTube's CDN (googlevideo.com) commonly serves a 403 mid-download
    // when the upstream IP is sharing rate-limit budget with other users,
    // especially via WARP / proxy exit IPs. yt-dlp resumes from the last
    // successful byte, so this is invisible to the user when it works and
    // turns previously-failed downloads into successes.
    "--retries",
    "10",
    "--fragment-retries",
    "10",
    "--retry-sleep",
    "5",
    // Parallelize HLS / DASH fragment downloads. Many sites (adult tube
    // sites in particular) serve content as HLS with hundreds of tiny
    // segments. Downloading them serially through a residential proxy is
    // bottlenecked by per-request latency, not bandwidth — a 3 MB/s exit
    // can deliver only ~150 KiB/s of effective throughput on serial HLS.
    // Pulling 16 fragments concurrently saturates the proxy's bandwidth.
    // Ignored by yt-dlp for progressive (non-fragmented) downloads, so
    // this is safe for plain MP4 / YouTube too.
    "--concurrent-fragments",
    "16",
    ...(FFMPEG_BINARY ? ["--ffmpeg-location", FFMPEG_BINARY] : []),
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

  let lastLoggedProgress = -1;

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

      // Echo progress to worker logs at 10% boundaries so `pm2 logs` is
      // useful for observing download speed without having to also tail
      // the PWA's polling. The original line includes speed + ETA.
      const bucket = Math.floor(progress / 10) * 10;
      if (bucket !== lastLoggedProgress) {
        lastLoggedProgress = bucket;
        console.log(`[job ${jobId}] ${trimmed}`);
      }
    } else if (
      /\[(youtube|info|download|ExtractAudio|Merger)\]/i.test(trimmed) ||
      /^ERROR/i.test(trimmed)
    ) {
      // Log non-progress yt-dlp status lines (extractor switches, format
      // selection, errors) so we can see what's happening end-to-end.
      console.log(`[job ${jobId}] ${trimmed}`);
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

    // YouTube URLs have an oEmbed fallback that doesn't go through yt-dlp,
    // so try that next — same proxy block won't necessarily affect it.
    let parsedUrl: URL | null = null;
    try {
      parsedUrl = new URL(normalizedUrl);
    } catch {
      parsedUrl = null;
    }

    if (parsedUrl && isYouTubeHost(parsedUrl.hostname)) {
      try {
        const fallbackMetadata = await extractOEmbedMetadata(normalizedUrl);
        return {
          metadata: fallbackMetadata,
          message: BASIC_METADATA_MESSAGE,
        };
      } catch {
        // fall through to placeholder
      }
    }

    // Non-YouTube URLs (or YouTube + dead oEmbed) get a placeholder so the
    // download can still attempt — yt-dlp's actual download path has its own
    // retry logic and often succeeds even when --dump-json gets rate-limited
    // or temporarily blocked. Worst case the download also fails, in which
    // case the user sees the real download error instead of a blocking
    // metadata error that prevented us from even trying.
    const placeholderTitle = parsedUrl
      ? buildPlaceholderTitle(parsedUrl)
      : "Untitled media";

    return {
      metadata: {
        title: placeholderTitle,
        duration: null,
        formats: [],
      },
      message: BASIC_METADATA_MESSAGE,
    };
  }
}

function buildPlaceholderTitle(parsedUrl: URL): string {
  // Trim path and use last meaningful segment so the user sees something
  // recognizable in the UI (e.g. /video/abc123 → "abc123") rather than the
  // raw URL.
  const segments = parsedUrl.pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1] ?? "";
  const decoded = decodeURIComponent(last)
    .replace(/[-_]+/g, " ")
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .trim();
  if (decoded.length > 2) {
    return `${decoded} — ${parsedUrl.hostname}`;
  }
  return parsedUrl.hostname;
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
