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
  /**
   * The exact HTTP request headers yt-dlp says this URL needs — most
   * importantly the User-Agent of the player_client that signed it.
   * Carried for completeness; the active HLS download path doesn't need
   * to spoof a UA because googlevideo serves HLS with CORS=*, but the
   * field stays in the type so a future "fetch via worker proxy"
   * fallback can pick it up if we ever bring that path back.
   */
  httpHeaders?: Record<string, string>;
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
  options: { signal?: AbortSignal; forSave?: boolean } = {},
): Promise<StreamSource> {
  const endpoint = getStreamEndpoint();
  const response = await fetch(endpoint.url, {
    method: "POST",
    headers: getRequestHeaders(endpoint.isExternal),
    body: JSON.stringify({
      url,
      type,
      // `forSave: true` puts the worker into HLS-only resolution mode so
      // the URL it hands back is a manifest we can disassemble client-
      // side. Plain streaming leaves this off so the worker still
      // returns whatever single playable URL it can (HLS preferred,
      // itag 18 fallback) for <video src=...>.
      ...(options.forSave ? { forSave: true } : {}),
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
 * Recognize an HLS manifest URL. yt-dlp tags HLS formats with protocol
 * `m3u8` or `m3u8_native`, but if that field is somehow missing we also
 * sniff the URL for the manifest path/extension as a backstop. Anything
 * that doesn't match is treated as a single-file progressive URL — which
 * the client-side download path *cannot* fetch (see comment block on
 * downloadStreamToBlob), so the caller will surface a clean error.
 */
function isHlsStream(streamUrl: string, protocol?: string): boolean {
  if (protocol && /m3u8/i.test(protocol)) {
    return true;
  }
  try {
    const parsed = new URL(streamUrl);
    if (parsed.pathname.endsWith(".m3u8")) {
      return true;
    }
    if (/\/(api\/)?manifest\/hls/i.test(parsed.pathname)) {
      return true;
    }
  } catch {
    // not a parseable URL — fall through to false
  }
  return false;
}

type HlsSegment = {
  url: string;
  /**
   * Some YouTube HLS variants pack the entire media stream into a single
   * mp4 file and address each segment as a byte range of that one file.
   * Encoded as `length@offset` in #EXT-X-BYTERANGE / EXT-X-MAP. When
   * present we translate it into an HTTP Range header.
   */
  byteRange?: { start: number; length: number };
};

/**
 * Tiny HLS parser. We don't need a full hls.js — we never play this
 * manifest, we just need the ordered list of byte sources to glue into
 * a Blob. Handles the subset of m3u8 features YouTube actually uses:
 *
 *   - Master playlists with one or more #EXT-X-STREAM-INF variants
 *     (we pick the highest-bandwidth one, which on YT's muxed
 *     low-res HLS chain is usually 360p).
 *   - Variant playlists with #EXT-X-MAP init segment + a sequence of
 *     #EXTINF segment URLs.
 *   - #EXT-X-BYTERANGE inline byte-range references against a single
 *     consolidated mp4 file — the encoding YouTube uses for most HLS
 *     content. We resolve relative byte ranges (no @offset means
 *     "right after the previous one") to absolute ones for HTTP Range.
 */
async function parseHlsManifest(
  manifestUrl: string,
  signal?: AbortSignal,
): Promise<{
  segments: HlsSegment[];
  initSegment: HlsSegment | null;
}> {
  const masterResp = await fetch(manifestUrl, { signal });
  if (!masterResp.ok) {
    throw new Error(`HLS manifest fetch failed (${masterResp.status}).`);
  }
  const masterText = await masterResp.text();

  let variantUrl = manifestUrl;
  let variantText = masterText;

  // Master playlist? Find the highest-bandwidth variant and recurse.
  if (masterText.includes("#EXT-X-STREAM-INF")) {
    const variants: Array<{ url: string; bandwidth: number }> = [];
    const lines = masterText.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.startsWith("#EXT-X-STREAM-INF")) {
        continue;
      }
      const bandwidthMatch = /BANDWIDTH=(\d+)/.exec(line);
      // Variant URL is on the line following the EXT-X-STREAM-INF tag,
      // unless that line is itself a tag (some authoring tools insert
      // multi-line attributes; we just keep scanning).
      for (let j = i + 1; j < lines.length; j += 1) {
        const candidate = lines[j].trim();
        if (!candidate || candidate.startsWith("#")) {
          continue;
        }
        variants.push({
          url: new URL(candidate, manifestUrl).toString(),
          bandwidth: bandwidthMatch ? Number(bandwidthMatch[1]) : 0,
        });
        break;
      }
    }
    if (variants.length === 0) {
      throw new Error("HLS master playlist contained no variants.");
    }
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    variantUrl = variants[0].url;
    const variantResp = await fetch(variantUrl, { signal });
    if (!variantResp.ok) {
      throw new Error(`HLS variant fetch failed (${variantResp.status}).`);
    }
    variantText = await variantResp.text();
  }

  const segments: HlsSegment[] = [];
  let initSegment: HlsSegment | null = null;
  let pendingByteRange: { start: number; length: number } | null = null;
  let lastByteRangeEnd = 0;

  for (const rawLine of variantText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (line.startsWith("#EXT-X-MAP:")) {
      const uriMatch = /URI="([^"]+)"/.exec(line);
      const brMatch = /BYTERANGE="(\d+)(?:@(\d+))?"/.exec(line);
      if (uriMatch) {
        let mapRange: { start: number; length: number } | undefined;
        if (brMatch) {
          const length = Number(brMatch[1]);
          const start = brMatch[2] !== undefined ? Number(brMatch[2]) : 0;
          mapRange = { start, length };
          lastByteRangeEnd = start + length;
        }
        initSegment = {
          url: new URL(uriMatch[1], variantUrl).toString(),
          byteRange: mapRange,
        };
      }
      continue;
    }

    if (line.startsWith("#EXT-X-BYTERANGE:")) {
      const m = /^#EXT-X-BYTERANGE:(\d+)(?:@(\d+))?$/.exec(line);
      if (m) {
        const length = Number(m[1]);
        const start = m[2] !== undefined ? Number(m[2]) : lastByteRangeEnd;
        pendingByteRange = { start, length };
        lastByteRangeEnd = start + length;
      }
      continue;
    }

    if (line.startsWith("#")) {
      continue;
    }

    segments.push({
      url: new URL(line, variantUrl).toString(),
      byteRange: pendingByteRange ?? undefined,
    });
    pendingByteRange = null;
  }

  return { segments, initSegment };
}

/**
 * Fetch all HLS segments in parallel (bounded concurrency) and glue them
 * into a single Blob. The init segment, when present, goes first.
 *
 * Why parallel: a typical 4-minute YouTube HLS variant has ~60 segments
 * of ~5s each. Serial fetching is dominated by per-request latency
 * (typically 80-300ms on mobile), so 60 × 200ms = 12s of wall-time
 * overhead before any bytes arrive. With concurrency 8 that drops to
 * ~1.5s of latency overhead and the actual byte throughput dominates.
 *
 * Why we keep `results[idx]` ordered: mp4 fragments concatenated out
 * of order produce a broken file (the moof timestamps no longer line
 * up with the mdat sample tables). Each worker writes into a fixed
 * slot, then we assemble at the end.
 */
async function fetchHlsSegments(
  segments: HlsSegment[],
  initSegment: HlsSegment | null,
  options: {
    signal?: AbortSignal;
    onProgress?: (loaded: number, total: number | null) => void;
  },
): Promise<ArrayBuffer[]> {
  const all = initSegment ? [initSegment, ...segments] : segments;
  const total = all.length;
  const results: ArrayBuffer[] = new Array(total);
  const concurrency = Math.min(8, total);
  let completed = 0;
  let bytesLoaded = 0;
  let cursor = 0;

  async function fetchOne(segment: HlsSegment): Promise<ArrayBuffer> {
    const headers: Record<string, string> = {};
    if (segment.byteRange) {
      const end = segment.byteRange.start + segment.byteRange.length - 1;
      headers.Range = `bytes=${segment.byteRange.start}-${end}`;
    }
    const resp = await fetch(segment.url, {
      signal: options.signal,
      headers,
    });
    // 206 Partial Content is the success case for ranged requests.
    if (!resp.ok && resp.status !== 206) {
      throw new Error(`Segment fetch failed (${resp.status}).`);
    }
    return resp.arrayBuffer();
  }

  options.onProgress?.(0, total);

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const idx = cursor;
        cursor += 1;
        if (idx >= total) {
          return;
        }
        const buf = await fetchOne(all[idx]);
        results[idx] = buf;
        completed += 1;
        bytesLoaded += buf.byteLength;
        // Report SEGMENT count as "loaded" — total is also in segments —
        // because we don't know the final byte total ahead of time.
        // The UI percentage stays meaningful and monotonic this way.
        options.onProgress?.(completed, total);
      }
    }),
  );

  // Touch bytesLoaded so eslint stops complaining about an unused
  // local. We may surface it in the future for a "downloaded N MB"
  // readout in the UI.
  void bytesLoaded;

  return results;
}

/**
 * Fetch a resolved stream URL and return it as a single Blob.
 *
 * Today this is HLS-only. The original "phone fetches a single
 * progressive googlevideo URL directly" plan didn't survive two facts:
 *
 *   1. googlevideo.com does NOT serve Access-Control-Allow-Origin on
 *      the `videoplayback?...` endpoint, so the browser fetch() fails
 *      CORS for non-HLS URLs (HLS works because the manifest endpoint
 *      DOES carry CORS).
 *   2. The fallback of proxying those URLs through our worker dies on
 *      googlevideo's datacenter-ASN block — DigitalOcean droplet IPs
 *      get an empty-body 403 regardless of UA / signed-URL freshness.
 *
 * HLS works because:
 *   - Both the .m3u8 and the segment URLs return CORS=* (this is what
 *     lets hls.js work in any browser).
 *   - Segments are fetched from the phone's residential IP, so the
 *     googlevideo CDN serves them happily and no IPRoyal / droplet
 *     bandwidth is touched at all.
 *
 * If the resolved URL is NOT HLS we throw a clear error instead of
 * spending a minute downloading something that will then fail CORS.
 * The caller surfaces it and the user can retry via the regular
 * yt-dlp downloader.
 */
export async function downloadStreamToBlob(
  streamUrl: string,
  options: {
    signal?: AbortSignal;
    mimeHint?: string;
    onProgress?: (loaded: number, total: number | null) => void;
    /**
     * yt-dlp's protocol hint. When present and non-HLS we fail fast
     * with a clear error rather than attempting an impossible fetch.
     */
    protocol?: string;
    /**
     * No longer used by the active HLS path (HLS endpoints are
     * CORS=* on googlevideo), but kept in the option bag for source
     * compatibility with callers wired up under the old worker-proxy
     * design.
     */
    userAgent?: string;
  } = {},
): Promise<Blob> {
  if (!isHlsStream(streamUrl, options.protocol)) {
    throw new Error(
      "Direct download is only available for HLS streams, and this " +
        "video doesn't expose one. Use the regular Download buttons " +
        "(via worker) to save it instead.",
    );
  }

  const { segments, initSegment } = await parseHlsManifest(
    streamUrl,
    options.signal,
  );

  if (segments.length === 0) {
    throw new Error("HLS manifest contained no segments.");
  }

  const buffers = await fetchHlsSegments(segments, initSegment, {
    signal: options.signal,
    onProgress: options.onProgress,
  });

  return new Blob(buffers as BlobPart[], {
    type: options.mimeHint || "video/mp4",
  });
}
