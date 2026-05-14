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

/** Worker yt-dlp runs can exceed 30s; cellular RTT adds more — default generous. */
const DEFAULT_STREAM_LOOKUP_TIMEOUT_MS = 180_000;

const RETRYABLE_HTTP = new Set([408, 429, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

function shouldRetryHttp(status: number, errorBody?: string): boolean {
  if (RETRYABLE_HTTP.has(status)) {
    return true;
  }
  if (errorBody && /timeout|temporarily|unavailable|rate|overload/i.test(errorBody)) {
    return true;
  }
  return false;
}

function isRetryableStreamError(error: unknown): boolean {
  if (error instanceof TypeError) {
    if (/failed to fetch|load failed|network/i.test(error.message)) {
      return true;
    }
  }
  if (error instanceof DOMException) {
    if (error.name === "TimeoutError") {
      return true;
    }
  }
  if (error instanceof Error) {
    if (/timed out|timeout|network|fetch/i.test(error.message)) {
      return true;
    }
  }
  return false;
}

function normalizeStreamFetchError(error: unknown): Error {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return new Error(
      "That took too long — weak mobile signal or busy servers. Try again; Wi‑Fi is more reliable.",
    );
  }
  if (error instanceof TypeError && /failed to fetch|load failed/i.test(error.message)) {
    return new Error(
      "Network failed while contacting the stream server. Check your connection and try again.",
    );
  }
  if (error instanceof Error) {
    return error;
  }
  return new Error("Couldn't load this video.");
}

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
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<StreamSource> {
  const endpoint = getStreamEndpoint();
  const timeoutMs = options.timeoutMs ?? DEFAULT_STREAM_LOOKUP_TIMEOUT_MS;
  const maxAttempts = 2;

  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => {
      controller.abort(new DOMException("Stream lookup timed out.", "TimeoutError"));
    }, timeoutMs);

    const clearTimer = () => {
      globalThis.clearTimeout(timer);
    };

    let userForward: (() => void) | undefined;
    if (options.signal) {
      if (options.signal.aborted) {
        clearTimer();
        const reason = options.signal.reason;
        throw reason instanceof Error ? reason : new DOMException("Aborted", "AbortError");
      }
      userForward = () => {
        clearTimer();
        controller.abort(options.signal!.reason);
      };
      options.signal.addEventListener("abort", userForward, { once: true });
    }

    try {
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: getRequestHeaders(endpoint.isExternal),
        body: JSON.stringify({ url, type }),
        signal: controller.signal,
      });
      clearTimer();
      if (userForward && options.signal) {
        options.signal.removeEventListener("abort", userForward);
      }

      let body: (StreamSource & { error?: string }) | null = null;
      try {
        body = (await response.json()) as StreamSource & { error?: string };
      } catch {
        body = null;
      }

      if (!response.ok || !body) {
        if (shouldRetryHttp(response.status, body?.error) && attempt < maxAttempts - 1) {
          await sleep(2000 + attempt * 1000);
          continue;
        }
        throw new Error(body?.error || `Couldn't load this video (${response.status}).`);
      }

      if (typeof body.url !== "string" || body.url.length === 0) {
        throw new Error("Couldn't load this video. Please try another.");
      }

      return body;
    } catch (error) {
      clearTimer();
      if (userForward && options.signal) {
        options.signal.removeEventListener("abort", userForward);
      }

      if (options.signal?.aborted) {
        throw error instanceof Error ? error : new DOMException("Aborted", "AbortError");
      }

      lastError = error;

      if (isRetryableStreamError(error) && attempt < maxAttempts - 1) {
        await sleep(2000 + attempt * 1000);
        continue;
      }

      throw normalizeStreamFetchError(error);
    }
  }

  throw normalizeStreamFetchError(lastError);
}
