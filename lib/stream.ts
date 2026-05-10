/**
 * Stream a YouTube video via a directly-playable signed CDN URL, without
 * going through YouTube's player. The worker calls yt-dlp with the ios+tv
 * player clients (which return non-IP-locked URLs) and hands back a single
 * googlevideo.com URL the browser can drop into a <video> or <audio> tag.
 *
 * Bandwidth flow:
 *   - Metadata roundtrip (~50 KB) goes through worker → IPRoyal (paid).
 *   - Actual video bytes go phone → googlevideo.com directly (free, fast,
 *     uses the device's own data plan).
 *
 * Side-effect: this is also automatic ad-blocking. YouTube's pre-roll /
 * mid-roll ads are inserted at *playback* time by their player; the raw
 * stream URL has no ads in it at all.
 */

export type StreamSource = {
  url: string;
  type: "audio" | "video";
  title?: string;
  author?: string;
  thumbnail?: string;
  duration?: number | null;
  expiresAt?: number;
};

type EndpointConfig = {
  url: string;
  isExternal: boolean;
};

function getStreamEndpoint(): EndpointConfig {
  const workerUrl = process.env.NEXT_PUBLIC_WORKER_API_URL?.trim();
  if (!workerUrl) {
    return { url: "/api/stream", isExternal: false };
  }
  return {
    url: `${workerUrl.replace(/\/$/, "")}/stream`,
    isExternal: true,
  };
}

function getRequestHeaders(isExternal: boolean): HeadersInit {
  const headers: HeadersInit = {
    "Content-Type": "application/json",
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

export async function fetchStreamSource(
  url: string,
  type: "audio" | "video",
  options: { signal?: AbortSignal } = {},
): Promise<StreamSource> {
  const endpoint = getStreamEndpoint();
  const response = await fetch(endpoint.url, {
    method: "POST",
    headers: getRequestHeaders(endpoint.isExternal),
    body: JSON.stringify({ url, type }),
    signal: options.signal,
  });

  let body: (StreamSource & { error?: string }) | null = null;
  try {
    body = (await response.json()) as StreamSource & { error?: string };
  } catch {
    body = null;
  }

  if (!response.ok || !body) {
    throw new Error(body?.error || `Stream lookup failed (${response.status})`);
  }

  if (typeof body.url !== "string" || body.url.length === 0) {
    throw new Error("Worker returned no stream URL.");
  }

  return body;
}
