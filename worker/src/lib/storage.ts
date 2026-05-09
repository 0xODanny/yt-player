import { access, mkdir, readdir, stat, unlink, writeFile } from "fs/promises";
import path from "path";
import { constants as fsConstants } from "fs";

import type { JobMetadata } from "../types/jobs";

export const DOWNLOADS_DIR = "/tmp/yt-worker-downloads";
const FILE_RETENTION_MS = 2 * 60 * 60 * 1_000;
const CLEANUP_INTERVAL_MS = 15 * 60 * 1_000;

export async function ensureDownloadsDir() {
  await mkdir(DOWNLOADS_DIR, { recursive: true });
}

export async function cleanupExpiredDownloads(now = Date.now()) {
  await ensureDownloadsDir();

  const entries = await readdir(DOWNLOADS_DIR, { withFileTypes: true });

  await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const filePath = path.join(DOWNLOADS_DIR, entry.name);
        const fileStats = await stat(filePath);

        if (now - fileStats.mtimeMs > FILE_RETENTION_MS) {
          await unlink(filePath);
        }
      }),
  );
}

export function startDownloadCleanupLoop() {
  void cleanupExpiredDownloads();

  const timer = setInterval(() => {
    void cleanupExpiredDownloads();
  }, CLEANUP_INTERVAL_MS);

  timer.unref();
}

export async function ensurePlaceholderDownload(jobId: string, metadata: JobMetadata) {
  await ensureDownloadsDir();

  const filename = getPlaceholderFilename(jobId);
  const filePath = path.join(DOWNLOADS_DIR, filename);

  try {
    await access(filePath, fsConstants.F_OK);
    return filename;
  } catch {
    const content = buildPlaceholderContent(jobId, metadata);
    await writeFile(filePath, content, "utf8");
    return filename;
  }
}

export function resolveDownloadPath(filename: string) {
  if (!filename || filename !== path.basename(filename) || filename.includes("\0")) {
    return null;
  }

  return path.join(DOWNLOADS_DIR, filename);
}

function getPlaceholderFilename(jobId: string) {
  const safeJobId = jobId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${safeJobId}.txt`;
}

function buildPlaceholderContent(jobId: string, metadata: JobMetadata) {
  return [
    "YT Worker Placeholder Output",
    "",
    `Job ID: ${jobId}`,
    `Title: ${metadata.title}`,
    `Author: ${metadata.author ?? "Unknown"}`,
    `Duration: ${metadata.duration ?? "Unknown"}`,
    `Formats detected: ${metadata.formats.length}`,
    "",
    "This is a placeholder generated file for local job infrastructure only.",
  ].join("\n");
}