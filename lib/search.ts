/**
 * YouTube search via our own worker. Public Invidious instances became
 * unreliable (rate-limited, CORS-broken, or shut down outright by their
 * operators), so we route search through the worker — which already has a
 * proxy pipeline (Cloudflare WARP / residential) and yt-dlp installed. This
 * gives us a stable search path and reuses the same anti-bot setup the
 * downloader uses, so search results match what we can actually download.
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

type WorkerSearchPayload = {
  results: Array<{
    videoId: string;
    title: string;
    author?: string;
    authorId?: string;
    lengthSeconds?: number;
    viewCount?: number;
    description?: string;
    thumbnail?: string;
    publishedText?: string;
  }>;
  error?: string;
};

type EndpointConfig = {
  url: string;
  isExternal: boolean;
};

function getSearchEndpoint(): EndpointConfig {
  const workerUrl = process.env.NEXT_PUBLIC_WORKER_API_URL?.trim();
  if (!workerUrl) {
    return {
      url: "/api/search",
      isExternal: false,
    };
  }
  return {
    url: `${workerUrl.replace(/\/$/, "")}/search`,
    isExternal: true,
  };
}

function getRequestHeaders(isExternal: boolean): HeadersInit {
  const headers: HeadersInit = {
    Accept: "application/json",
  };
  if (!isExternal) {
    return headers;
  }
  const apiKey = process.env.NEXT_PUBLIC_WORKER_API_KEY?.trim();
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

export type SearchOptions = {
  signal?: AbortSignal;
  limit?: number;
};

export async function searchVideos(
  query: string,
  { signal, limit = 20 }: SearchOptions = {},
): Promise<SearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }

  const endpoint = getSearchEndpoint();
  const url = new URL(endpoint.url, typeof window !== "undefined" ? window.location.origin : "http://localhost");
  url.searchParams.set("q", trimmed);
  url.searchParams.set("limit", String(limit));

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: getRequestHeaders(endpoint.isExternal),
    signal,
  });

  let body: WorkerSearchPayload | null = null;
  try {
    body = (await response.json()) as WorkerSearchPayload;
  } catch {
    body = null;
  }

  if (!response.ok) {
    const message = body?.error || `Couldn't search (${response.status}).`;
    throw new Error(message);
  }

  if (!body || !Array.isArray(body.results)) {
    return [];
  }

  return body.results.map((entry) => ({
    videoId: entry.videoId,
    title: entry.title,
    author: entry.author,
    authorId: entry.authorId,
    lengthSeconds: entry.lengthSeconds,
    viewCount: entry.viewCount,
    description: entry.description,
    publishedText: entry.publishedText,
    thumbnails: entry.thumbnail
      ? [{ url: entry.thumbnail, width: 480, height: 360 }]
      : [],
  }));
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

/**
 * Extract YouTube video id from a saved library `sourceUrl` (watch URL,
 * youtu.be, etc.). Used to mark search results already in the library.
 */
export function videoIdFromSourceUrl(sourceUrl: string | undefined | null): string | null {
  if (!sourceUrl || typeof sourceUrl !== "string") {
    return null;
  }
  try {
    const url = new URL(sourceUrl);
    if (url.hostname === "youtu.be") {
      const id = url.pathname.replace(/^\//, "").trim();
      return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
    }
    if (
      url.hostname === "www.youtube.com" ||
      url.hostname === "youtube.com" ||
      url.hostname === "m.youtube.com"
    ) {
      const v = url.searchParams.get("v");
      return v && /^[A-Za-z0-9_-]{11}$/.test(v) ? v : null;
    }
    return null;
  } catch {
    return null;
  }
}
