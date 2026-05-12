/**
 * In-memory LRU cache + in-flight dedup for /stream URL resolutions.
 *
 * Why this exists:
 *   Resolving a YouTube watch URL to a signed googlevideo.com URL
 *   costs 13-14 seconds end to end on our 1 vCPU droplet — the
 *   bottleneck is yt-dlp running the deno-based n-challenge solver
 *   while bouncing requests through the IPRoyal residential proxy.
 *   That latency is paid in full every time the user taps a result,
 *   even if they tapped the same result 30 seconds ago.
 *
 *   YouTube's signed CDN URLs themselves are valid for ~6 hours, so
 *   it's perfectly safe to memoize the result of a successful
 *   resolution for some fraction of that window. After caching, a
 *   repeat tap on the same video → instant playback (cache lookup
 *   is single-digit milliseconds). The user-perceived "downloads are
 *   slow" problem largely goes away.
 *
 * Design choices:
 *
 *   - Keyed by (videoId, type) so different URL spellings of the
 *     same video (youtu.be/X, m.youtube.com/watch?v=X, etc.) share
 *     cache entries. Caller passes the canonical id; helpers below
 *     extract it from raw URLs.
 *
 *   - TTL is min(soft cap, expire-30s) where the soft cap is
 *     conservatively 30 minutes. Even if yt-dlp's reported expiresAt
 *     is several hours out, we don't want a stale URL hanging around
 *     past common watch sessions — clients re-resolving against a
 *     URL minutes from expiry is poor UX.
 *
 *   - LRU eviction at a hard cap of 256 entries (≈ 500 KB at ~2 KB
 *     per entry). Realistic concurrent video set per worker is
 *     under 100; this gives plenty of headroom without unbounded
 *     growth.
 *
 *   - In-flight Promise dedup: if request B arrives while request A
 *     for the same key is still running yt-dlp, B awaits A's promise
 *     instead of forking a second yt-dlp subprocess. Two simultaneous
 *     taps from one user (e.g. play AND queue-download) now cost one
 *     resolution, not two.
 *
 *   - Failed resolutions are NOT cached. A "Video unavailable" today
 *     might be available in 5 minutes (region-restricted, age-gated
 *     after sign-in, etc.). Caching errors would force re-deploys
 *     every time a transient blocker resolved.
 */

const SOFT_TTL_MS = 30 * 60 * 1_000;
const EXPIRY_SAFETY_MARGIN_S = 30;
const MAX_ENTRIES = 256;

export type CacheableResult = {
  /** yt-dlp-resolved signed CDN URL (used in <video src=…>) */
  url: string;
  /** Epoch seconds when the signed URL expires (from yt-dlp), if known. */
  expiresAt?: number;
  /**
   * Arbitrary serializable payload (metadata for the player UI).
   * We deliberately store the whole WorkerStreamResult, not just url,
   * so cached responses are byte-identical to fresh ones.
   */
  [extra: string]: unknown;
};

type CacheEntry = {
  result: CacheableResult;
  cachedAt: number;
  /**
   * Absolute epoch ms after which this entry MUST be discarded.
   * = min(cachedAt + SOFT_TTL_MS, expiresAt * 1000 - margin).
   */
  invalidAt: number;
};

/**
 * Extract the canonical YouTube video id from any of the URL forms
 * yt-dlp accepts. Returns null when the URL doesn't include a
 * recognizable id — callers should treat that as "uncacheable" and
 * skip the cache entirely instead of caching with the raw URL as key
 * (different URL spellings of the same video would otherwise blow
 * past each other).
 */
export function videoIdFromUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.hostname === "youtu.be") {
      return url.pathname.replace(/^\//, "").trim() || null;
    }
    if (
      url.hostname === "www.youtube.com" ||
      url.hostname === "youtube.com" ||
      url.hostname === "m.youtube.com" ||
      url.hostname === "music.youtube.com"
    ) {
      const vid = url.searchParams.get("v");
      if (vid && /^[A-Za-z0-9_-]{11}$/.test(vid)) {
        return vid;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function cacheKey(videoId: string, type: string): string {
  return `${videoId}:${type}`;
}

// Map preserves insertion order on iteration, which we use to find
// the oldest entry when evicting. We re-insert on each get() to keep
// most-recently-used at the back, oldest at the front.
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<CacheableResult>>();

let hitCount = 0;
let missCount = 0;

function isValid(entry: CacheEntry): boolean {
  return Date.now() < entry.invalidAt;
}

function computeInvalidAt(cachedAt: number, expiresAtEpochSec?: number): number {
  const softDeadline = cachedAt + SOFT_TTL_MS;
  if (!expiresAtEpochSec || !Number.isFinite(expiresAtEpochSec)) {
    return softDeadline;
  }
  const hardDeadline = expiresAtEpochSec * 1000 - EXPIRY_SAFETY_MARGIN_S * 1000;
  return Math.min(softDeadline, hardDeadline);
}

/**
 * Try to serve from cache. Returns null on miss (or expired entry,
 * which is also evicted as a side effect). On hit, the entry is
 * re-inserted into the Map so LRU order is maintained.
 */
export function getCachedStream(
  videoId: string,
  type: string,
): CacheableResult | null {
  const key = cacheKey(videoId, type);
  const entry = cache.get(key);
  if (!entry) {
    missCount += 1;
    return null;
  }
  if (!isValid(entry)) {
    cache.delete(key);
    missCount += 1;
    return null;
  }
  // Re-insert to bump LRU position.
  cache.delete(key);
  cache.set(key, entry);
  hitCount += 1;
  return entry.result;
}

export function setCachedStream(
  videoId: string,
  type: string,
  result: CacheableResult,
): void {
  const key = cacheKey(videoId, type);
  const cachedAt = Date.now();
  cache.set(key, {
    result,
    cachedAt,
    invalidAt: computeInvalidAt(cachedAt, result.expiresAt),
  });
  // Evict oldest until we're back under cap. Map iteration goes in
  // insertion order, so .keys().next() gives us the LRU entry.
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

/**
 * Returns the in-flight promise for this key, if any. Callers should
 * always check this BEFORE doing any work — if another request beat
 * us to it, we can just await its result and avoid spawning a second
 * yt-dlp subprocess for the same video.
 */
export function getInflightStream(
  videoId: string,
  type: string,
): Promise<CacheableResult> | null {
  return inflight.get(cacheKey(videoId, type)) ?? null;
}

/**
 * Register a Promise that's currently resolving this (videoId, type).
 * The promise is automatically removed from the in-flight map when it
 * settles, regardless of success or failure — so a failed resolution
 * doesn't block retries indefinitely.
 */
export function trackInflightStream<T extends CacheableResult>(
  videoId: string,
  type: string,
  promise: Promise<T>,
): void {
  const key = cacheKey(videoId, type);
  inflight.set(key, promise as unknown as Promise<CacheableResult>);
  void promise.finally(() => {
    // Only remove if it's still us — a later overwrite would have
    // replaced the entry; we don't want to clear someone else's.
    if (inflight.get(key) === (promise as unknown)) {
      inflight.delete(key);
    }
  });
}

export function streamCacheStats() {
  return {
    entries: cache.size,
    inflight: inflight.size,
    hits: hitCount,
    misses: missCount,
    hitRate:
      hitCount + missCount === 0
        ? null
        : Number((hitCount / (hitCount + missCount)).toFixed(2)),
  };
}
