/**
 * YouTube search via Invidious — open-source YouTube API mirrors that don't
 * require a Google Cloud project or API key. We fetch the live list of healthy
 * public instances from api.invidious.io, cache it for an hour, and try each
 * one in order until a search succeeds. This gives us "search just works" UX
 * without users having to set up anything in Google Cloud.
 *
 * If all instances fail (rare but possible during YouTube API churn), the
 * caller gets a clear error and can fall back to manual URL entry.
 */

export type SearchResultThumbnail = {
  url: string;
  width: number;
  height: number;
};

export type SearchResult = {
  videoId: string;
  title: string;
  author?: string;
  authorId?: string;
  lengthSeconds?: number;
  viewCount?: number;
  description?: string;
  thumbnails: SearchResultThumbnail[];
  publishedText?: string;
};

type RawInvidiousResult = {
  type?: string;
  videoId?: string;
  title?: string;
  author?: string;
  authorId?: string;
  lengthSeconds?: number;
  viewCount?: number;
  description?: string;
  videoThumbnails?: SearchResultThumbnail[];
  publishedText?: string;
};

type RawInstanceEntry = [
  string,
  {
    api?: boolean;
    cors?: boolean;
    type?: string;
    uri?: string;
    monitor?: { dailyRatios?: Array<{ ratio?: string }> };
  },
];

const INSTANCES_URL = "https://api.invidious.io/instances.json?sort_by=health";
const INSTANCES_CACHE_KEY = "yt-local-tool:invidious-instances";
const INSTANCES_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Hardcoded fallbacks if api.invidious.io is itself unreachable. These get
// rotated by the community, so the live list is preferred.
const HARDCODED_INSTANCES = [
  "https://invidious.nerdvpn.de",
  "https://yewtu.be",
  "https://invidious.privacydev.net",
  "https://invidious.protokolla.fi",
  "https://invidious.lunar.icu",
];

type InstanceCache = {
  fetchedAt: number;
  instances: string[];
};

function readInstanceCache(): InstanceCache | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(INSTANCES_CACHE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as InstanceCache;
    if (Date.now() - parsed.fetchedAt > INSTANCES_CACHE_TTL_MS) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeInstanceCache(instances: string[]): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const payload: InstanceCache = { fetchedAt: Date.now(), instances };
    window.localStorage.setItem(INSTANCES_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // ignore quota errors
  }
}

async function fetchLiveInstances(signal?: AbortSignal): Promise<string[]> {
  const response = await fetch(INSTANCES_URL, { signal });
  if (!response.ok) {
    throw new Error(`Failed to load Invidious instance list (${response.status})`);
  }
  const data = (await response.json()) as RawInstanceEntry[];
  return data
    .filter(
      ([, info]) =>
        info?.type === "https" && info?.api === true && info?.cors === true && Boolean(info?.uri),
    )
    .map(([, info]) => (info.uri ?? "").replace(/\/$/, ""))
    .filter(Boolean)
    .slice(0, 8);
}

export async function getInstances(signal?: AbortSignal): Promise<string[]> {
  const cached = readInstanceCache();
  if (cached && cached.instances.length > 0) {
    return cached.instances;
  }
  try {
    const live = await fetchLiveInstances(signal);
    if (live.length > 0) {
      writeInstanceCache(live);
      return live;
    }
  } catch {
    // fall through to hardcoded list
  }
  return HARDCODED_INSTANCES;
}

function normalizeRaw(raw: RawInvidiousResult): SearchResult | null {
  if (!raw.videoId || !raw.title) {
    return null;
  }
  return {
    videoId: raw.videoId,
    title: raw.title,
    author: raw.author,
    authorId: raw.authorId,
    lengthSeconds: typeof raw.lengthSeconds === "number" ? raw.lengthSeconds : undefined,
    viewCount: typeof raw.viewCount === "number" ? raw.viewCount : undefined,
    description: raw.description,
    thumbnails: Array.isArray(raw.videoThumbnails) ? raw.videoThumbnails : [],
    publishedText: raw.publishedText,
  };
}

export type SearchOptions = {
  signal?: AbortSignal;
};

export async function searchVideos(
  query: string,
  { signal }: SearchOptions = {},
): Promise<SearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }

  const instances = await getInstances(signal);
  let lastError: Error | null = null;

  for (const baseUrl of instances) {
    try {
      const url = `${baseUrl}/api/v1/search?q=${encodeURIComponent(trimmed)}&type=video`;
      const response = await fetch(url, { signal });
      if (!response.ok) {
        lastError = new Error(`${baseUrl} returned ${response.status}`);
        continue;
      }
      const data = (await response.json()) as RawInvidiousResult[];
      const results = data
        .filter((entry) => entry.type === "video" || (!entry.type && entry.videoId))
        .map(normalizeRaw)
        .filter((entry): entry is SearchResult => entry !== null);
      return results;
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw error;
      }
      lastError = error instanceof Error ? error : new Error(String(error));
      continue;
    }
  }

  throw lastError ?? new Error("All search providers are unreachable.");
}

/**
 * Pick the best thumbnail at or below a target width for fast loading.
 * Falls back to the largest available if no smaller match is found.
 */
export function pickThumbnail(
  thumbnails: SearchResultThumbnail[],
  targetWidth = 360,
): SearchResultThumbnail | null {
  if (!Array.isArray(thumbnails) || thumbnails.length === 0) {
    return null;
  }
  const sorted = [...thumbnails].sort((a, b) => a.width - b.width);
  const small = sorted.find((thumb) => thumb.width >= targetWidth);
  return small ?? sorted[sorted.length - 1];
}

export function formatViewCount(count: number | undefined): string | null {
  if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) {
    return null;
  }
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1)}M views`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(count >= 10_000 ? 0 : 1)}K views`;
  }
  return `${count} views`;
}

export function formatLength(seconds: number | undefined): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hours > 0) {
    return `${hours}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

export function youtubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}
