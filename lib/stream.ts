/**
 * Stream a YouTube video via a directly-playable signed CDN URL, without
 * going through YouTube's player. The worker calls yt-dlp with the
 * ios/tv/mweb/android player clients (which return URLs that aren't
 * IP-locked to the resolver) and hands back a single googlevideo.com
 * URL the browser can drop into a <video> or <audio> tag.
 *
 * Bandwidth flow:
 *   - Metadata roundtrip (~50 KB) goes through worker → IPRoyal (paid).
 *   - Actual video bytes go phone → googlevideo.com directly (free,
 *     fast, uses the device's own data plan).
 *
 * Side-effect: this is also automatic ad-blocking. YouTube's pre-roll
 * and mid-roll ads are inserted at *playback* time by their player;
 * the raw stream URL has no ads in it at all.
 *
 * The corresponding "save to library via the same direct CDN URL"
 * feature is intentionally not present anymore. PO Token enforcement
 * in 2026 stripped yt-dlp's access to HLS for these clients, leaving
 * only the legacy itag 18 progressive URL — which the browser can
 * <video src=...> play but cannot fetch() (no CORS), and which the
 * worker cannot proxy on the user's behalf (googlevideo blocks the
 * DigitalOcean ASN). Anything that needs the bytes on disk now goes
 * through the worker's yt-dlp download path. See git history for
 * the previous HLS-client-side implementation if YouTube ever
 * reopens those endpoints.
 */

export type StreamSource = {
  url: string;
  type: "audio" | "video";
  /**
   * yt-dlp's protocol field. "m3u8" / "m3u8_native" means HLS — plays
   * natively on iOS Safari but needs hls.js on Chrome/Firefox/Android.
   * "https" means a single progressive stream — plays everywhere.
   */
  protocol?: string;
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
