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
  /**
   * yt-dlp's protocol field. "m3u8" / "m3u8_native" means HLS — plays
   * natively on iOS Safari but needs hls.js on Chrome/Firefox/Android.
   * "https" means a single progressive stream — plays everywhere.
   */
  protocol?: string;
  /**
   * Container extension reported by yt-dlp (e.g. "mp4", "m4a"). Used by
   * the direct-CDN download path to pick a filename hint and label when
   * the blob is saved to the OPFS library.
   */
  ext?: string;
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
  options: { signal?: AbortSignal; progressive?: boolean } = {},
): Promise<StreamSource> {
  const endpoint = getStreamEndpoint();
  const response = await fetch(endpoint.url, {
    method: "POST",
    headers: getRequestHeaders(endpoint.isExternal),
    body: JSON.stringify({
      url,
      type,
      // Only send `progressive: true` when the caller is going to
      // download the URL via fetch() and save it to OPFS — that path
      // can't handle HLS playlists. For plain streaming we leave this
      // off so the worker still prefers HLS when it's available.
      ...(options.progressive ? { progressive: true } : {}),
    }),
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

/**
 * Build the worker-side byte-proxy URL for a resolved googlevideo
 * stream URL. We route through the worker (not phone → CDN directly)
 * because googlevideo.com does not send Access-Control-Allow-Origin
 * for the progressive `videoplayback?...` endpoint, which means
 * fetch().then(r => r.blob()) fails CORS in every browser. The worker
 * fetches it from the droplet's bare IP (no IPRoyal — the signed
 * URL is already resolved, googlevideo doesn't care which IP retrieves
 * it) and emits the bytes under CORS headers we control.
 *
 * Cost trade-off vs. the original "phone fetches CDN directly" idea:
 *   - IPRoyal residential proxy: still zero bytes for the file body
 *     (only the ~50 KB metadata roundtrip needs IPRoyal). This was
 *     the paid/metered resource, and the whole point of the feature.
 *   - DigitalOcean droplet egress: now pays the bytes (~5 MB / song,
 *     ~50 MB / video). Included in the base plan up to 1 TB/mo,
 *     $0.01/GB after that. Effectively free.
 */
function getStreamProxyUrl(streamUrl: string): EndpointConfig {
  const workerUrl = process.env.NEXT_PUBLIC_WORKER_API_URL?.trim();
  if (!workerUrl) {
    return {
      url: `/api/stream/proxy?url=${encodeURIComponent(streamUrl)}`,
      isExternal: false,
    };
  }
  return {
    url: `${workerUrl.replace(/\/$/, "")}/stream/proxy?url=${encodeURIComponent(streamUrl)}`,
    isExternal: true,
  };
}

/**
 * Fetch a resolved stream URL through the worker byte-proxy and return
 * a single Blob, reporting progress as bytes arrive. Used by the
 * direct-CDN download path so we can save the file to OPFS without
 * ever sending bytes through the residential IPRoyal proxy.
 *
 * Why we hand-roll the reader loop instead of `response.blob()`:
 *   - We need to surface progress to the UI for downloads big enough
 *     that the user might cancel mid-fetch.
 *   - We want to honor an AbortSignal so the Stop button on the
 *     direct-download row actually cuts the connection (the worker
 *     in turn aborts the upstream googlevideo fetch so droplet
 *     bandwidth isn't burned on a cancelled download).
 */
export async function downloadStreamToBlob(
  streamUrl: string,
  options: {
    signal?: AbortSignal;
    mimeHint?: string;
    onProgress?: (loaded: number, total: number | null) => void;
  } = {},
): Promise<Blob> {
  const proxy = getStreamProxyUrl(streamUrl);
  const headers: HeadersInit = {};
  const apiKey = process.env.NEXT_PUBLIC_WORKER_API_KEY?.trim();
  if (proxy.isExternal && apiKey) {
    (headers as Record<string, string>).Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(proxy.url, {
    signal: options.signal,
    headers,
  });

  if (!response.ok || !response.body) {
    throw new Error(`Direct CDN download failed (${response.status}).`);
  }

  const contentLengthHeader = response.headers.get("content-length");
  const total = contentLengthHeader ? Number(contentLengthHeader) : null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;

  options.onProgress?.(0, Number.isFinite(total) ? (total as number) : null);

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    loaded += value.byteLength;
    options.onProgress?.(loaded, Number.isFinite(total) ? (total as number) : null);
  }

  return new Blob(chunks as BlobPart[], {
    type:
      options.mimeHint ||
      response.headers.get("content-type") ||
      "application/octet-stream",
  });
}
