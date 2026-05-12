/**
 * Tiny in-memory ring buffer + helpers for surfacing recent worker
 * activity to the /diag endpoint. We deliberately keep this on the
 * process heap (not Redis / disk) — losing samples on a pm2 restart
 * is fine, the data is only ever used for "is this slow right now?"
 * troubleshooting, not historical analytics. Total memory budget for
 * the buffers below is well under 100 KB even when fully populated.
 */
export type StreamSample = {
  at: number; // epoch ms when the call started
  elapsedMs: number;
  type: "audio" | "video";
  host: string;
  ok: boolean;
  /**
   * True when this sample was served from the in-memory resolution
   * cache instead of running yt-dlp. cache hits should be ~ms,
   * misses ~13-14 s on our droplet. Tracked separately in /diag's
   * summary so you can tell at a glance whether the cache is doing
   * its job for the active traffic.
   */
  cacheHit?: boolean;
  /** Short error tag when ok=false; sanitized + capped to 120 chars. */
  error?: string;
};

export type JobSample = {
  at: number;
  finishedAt: number;
  elapsedMs: number;
  format: string;
  quality: string;
  host: string;
  status: "complete" | "failed" | "cancelled";
  /** Highest speed yt-dlp reported during the download, in MiB/s. */
  peakMiBps?: number;
  /** Final file size in bytes when known. */
  fileSize?: number;
  /** Short error tag for failed jobs; sanitized + capped to 120 chars. */
  error?: string;
};

class RingBuffer<T> {
  private buf: T[] = [];
  constructor(private readonly capacity: number) {}
  push(item: T): void {
    this.buf.push(item);
    if (this.buf.length > this.capacity) {
      this.buf.splice(0, this.buf.length - this.capacity);
    }
  }
  toArray(): T[] {
    return this.buf.slice().reverse();
  }
}

const streamSamples = new RingBuffer<StreamSample>(30);
const jobSamples = new RingBuffer<JobSample>(30);

export function recordStreamSample(sample: StreamSample): void {
  streamSamples.push(sample);
}

export function recordJobSample(sample: JobSample): void {
  jobSamples.push(sample);
}

export function recentStreamSamples(): StreamSample[] {
  return streamSamples.toArray();
}

export function recentJobSamples(): JobSample[] {
  return jobSamples.toArray();
}

/**
 * Parse the speed token out of a yt-dlp progress line like:
 *   [download]  87.4% of  120.34MiB at  3.21MiB/s ETA 00:08
 * Returns megabytes-per-second as a plain number so callers can
 * compare without unit gymnastics. Returns null if no speed token
 * matched (e.g. "Unknown speed" lines).
 */
export function parseYtDlpSpeedMiBps(line: string): number | null {
  const match = /at\s+([\d.]+)\s*(KiB|MiB|GiB)\/s/i.exec(line);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  switch (match[2].toLowerCase()) {
    case "kib":
      return value / 1024;
    case "mib":
      return value;
    case "gib":
      return value * 1024;
    default:
      return null;
  }
}

export function safeHostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "(invalid)";
  }
}
