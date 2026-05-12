import { execFile } from "child_process";
import os from "os";
import { stat } from "fs/promises";
import { Router } from "express";
import { promisify } from "util";

import { requireWorkerAuth } from "../lib/auth";
import {
  recentJobSamples,
  recentStreamSamples,
} from "../lib/metrics";

const execFileAsync = promisify(execFile);
const diagRouter = Router();

// All diag info is potentially-sensitive (cookies file path, proxy
// presence, internal IPs in stderr). Gate behind the same Bearer
// secret the rest of the worker uses so a random scrape can't snapshot
// our state.
diagRouter.use(requireWorkerAuth);

// yt-dlp --version takes 100-300ms to spawn — cache the answer for
// 5 minutes so /diag stays snappy under repeated polling. The version
// realistically never changes between scrapes; if it does, the
// staleness is irrelevant for the data /diag is meant to surface.
let ytDlpVersionCache: { value: string; cachedAt: number } | null = null;
const YT_DLP_VERSION_TTL_MS = 5 * 60 * 1_000;

async function getYtDlpVersion(): Promise<string> {
  if (
    ytDlpVersionCache &&
    Date.now() - ytDlpVersionCache.cachedAt < YT_DLP_VERSION_TTL_MS
  ) {
    return ytDlpVersionCache.value;
  }
  const binary = process.env.YT_DLP_BINARY?.trim() || "yt-dlp";
  try {
    const { stdout } = await execFileAsync(binary, ["--version"], {
      timeout: 3_000,
    });
    const value = stdout.trim() || "(empty)";
    ytDlpVersionCache = { value, cachedAt: Date.now() };
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `(error: ${message.slice(0, 120)})`;
  }
}

async function describeCookiesFile() {
  const path = process.env.YT_DLP_COOKIES?.trim() || "";
  if (!path) {
    return { configured: false as const };
  }
  try {
    const stats = await stat(path);
    return {
      configured: true as const,
      exists: true as const,
      path,
      sizeBytes: stats.size,
      // mtime tells us when the cookies file was last rotated.
      // Anything older than ~10 days strongly suggests stale YouTube
      // auth, which is the most common cause of slow / failing
      // yt-dlp resolutions.
      mtimeIso: stats.mtime.toISOString(),
      ageDays: Math.round((Date.now() - stats.mtimeMs) / 86_400_000),
    };
  } catch (error) {
    return {
      configured: true as const,
      exists: false as const,
      path,
      error: error instanceof Error ? error.message.slice(0, 160) : String(error),
    };
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

function p95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[idx];
}

/**
 * GET /diag — HTTPS-only diagnostic snapshot. Designed so a single
 * authenticated curl from the dev's laptop replaces SSH'ing into the
 * droplet to grab pm2 status, cookies-file age, and recent
 * latency / error rates.
 *
 * Returns:
 *  - worker: process uptime, memory, load, hostname
 *  - env: presence/absence of key vars (NEVER the values themselves,
 *         to avoid leaking proxy credentials)
 *  - cookies: cookies file path + age (mtime) + size — stale cookies
 *             are the single most common cause of slow yt-dlp resolutions
 *  - ytDlp: version string (cached 5min)
 *  - recentStreams / recentJobs: ring-buffered last 30 calls of each
 *             type with elapsed time, outcome, and peak speed (jobs)
 *  - summary: median/p95 latency + ok-rate per type, the "is it slow
 *             right now?" number
 */
diagRouter.get("/", async (_req, res) => {
  const streamSamples = recentStreamSamples();
  const jobSamples = recentJobSamples();

  const streamElapsed = streamSamples.map((s) => s.elapsedMs);
  const jobElapsed = jobSamples
    .filter((s) => s.status === "complete")
    .map((s) => s.elapsedMs);
  const jobPeaks = jobSamples
    .map((s) => s.peakMiBps)
    .filter((v): v is number => typeof v === "number" && v > 0);

  const cookies = await describeCookiesFile();
  const ytDlpVersion = await getYtDlpVersion();
  const memory = process.memoryUsage();

  res.json({
    generatedAt: new Date().toISOString(),
    worker: {
      uptimeSeconds: Math.round(process.uptime()),
      hostname: os.hostname(),
      platform: process.platform,
      nodeVersion: process.version,
      pid: process.pid,
      memoryRssMb: Math.round(memory.rss / (1024 * 1024)),
      memoryHeapUsedMb: Math.round(memory.heapUsed / (1024 * 1024)),
      loadAvg1m: Number(os.loadavg()[0].toFixed(2)),
      loadAvg5m: Number(os.loadavg()[1].toFixed(2)),
      cpuCount: os.cpus().length,
      totalMemMb: Math.round(os.totalmem() / (1024 * 1024)),
      freeMemMb: Math.round(os.freemem() / (1024 * 1024)),
    },
    env: {
      hasProxy: Boolean(process.env.YT_DLP_PROXY?.trim()),
      hasCookies: Boolean(process.env.YT_DLP_COOKIES?.trim()),
      hasFfmpeg: Boolean(process.env.FFMPEG_BINARY?.trim()),
      ytDlpPlayerClients:
        process.env.YT_DLP_PLAYER_CLIENTS?.trim() || "(default)",
      allowedOrigins: (process.env.ALLOWED_ORIGIN?.trim() || "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
      workerPublicUrl: process.env.WORKER_PUBLIC_URL?.trim() || "(derived)",
    },
    cookies,
    ytDlp: { version: ytDlpVersion },
    summary: {
      streamCount: streamSamples.length,
      streamOkRate:
        streamSamples.length === 0
          ? null
          : Number(
              (
                streamSamples.filter((s) => s.ok).length /
                streamSamples.length
              ).toFixed(2),
            ),
      streamMedianMs: median(streamElapsed),
      streamP95Ms: p95(streamElapsed),
      jobCount: jobSamples.length,
      jobCompleteRate:
        jobSamples.length === 0
          ? null
          : Number(
              (
                jobSamples.filter((s) => s.status === "complete").length /
                jobSamples.length
              ).toFixed(2),
            ),
      jobMedianMs: median(jobElapsed),
      jobP95Ms: p95(jobElapsed),
      jobMedianPeakMiBps: median(jobPeaks),
    },
    recentStreams: streamSamples,
    recentJobs: jobSamples,
  });
});

export { diagRouter };
