import { Router } from "express";

import { requireWorkerAuth } from "../lib/auth";
import { getStreamUrl, isValidMediaSourceUrl } from "../lib/jobs";

const streamRouter = Router();

streamRouter.use(requireWorkerAuth);

/**
 * Whitelist of hosts the proxy is willing to fetch from. We MUST gate
 * this — without a host check the route is an open SSRF / abuse vector
 * that anyone with the worker API key could turn into a free HTTP
 * proxy. googlevideo.com is the only host that yt-dlp ever returns for
 * the resolved single-stream URL.
 */
function isAllowedProxyHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === "googlevideo.com" ||
    h.endsWith(".googlevideo.com") ||
    h === "manifest.googlevideo.com"
  );
}

/**
 * Resolve a watch URL to a directly-playable signed CDN URL so the
 * frontend can drop it straight into a <video>/<audio> tag and stream
 * without ever fetching the full file. Bypasses YouTube's player ⇒
 * no ads, no anti-adblock interstitial.
 *
 * Body: { url: string, type: "audio" | "video" }
 * Returns: { url, type, title?, author?, thumbnail?, duration?, expiresAt? }
 *
 * The bandwidth cost on the server side is just this metadata call
 * (~50KB). The actual video bytes flow phone ↔ googlevideo.com directly.
 */
streamRouter.post("/", async (request, response) => {
  const body = request.body as {
    url?: unknown;
    type?: unknown;
    progressive?: unknown;
  };

  if (typeof body?.url !== "string" || !isValidMediaSourceUrl(body.url)) {
    response.status(400).json({ error: "A valid http(s) `url` is required." });
    return;
  }

  const type = body.type === "audio" ? "audio" : "video";
  // `progressive` opts into the single-file format chain so the URL can
  // be fetched by the browser and written to OPFS in one go (vs. HLS
  // which would require segment-by-segment assembly client-side).
  const progressive = body.progressive === true;

  try {
    const result = await getStreamUrl(body.url, type, { progressive });
    response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Stream lookup failed.";
    response.status(502).json({ error: message });
  }
});

/**
 * Byte-stream a resolved googlevideo.com URL back to the client.
 *
 * Why this exists:
 *   The progressive `videoplayback?...` endpoint on googlevideo.com does
 *   not serve Access-Control-Allow-Origin headers (HLS manifests/segments
 *   do, which is why <video src=...> streaming works — that's an opaque
 *   media load, not a JS-readable fetch). So the PWA can't fetch().then(
 *   r => r.blob()) a googlevideo URL directly to save it to OPFS.
 *
 *   This proxy route lets the worker fetch the URL from the droplet's
 *   bare IP (no IPRoyal — the URL is already signed, googlevideo doesn't
 *   care which IP retrieves it) and stream the body back under CORS
 *   headers we control. End result: zero IPRoyal residential bandwidth
 *   is consumed for the file body (only the initial metadata lookup
 *   needed the proxy), and the user's library save works on every
 *   platform.
 *
 * Cost model:
 *   - Inbound to droplet: free for DigitalOcean.
 *   - Outbound to user: included in the droplet plan up to ~1 TB/mo,
 *     $0.01/GB after that. Effectively free.
 *
 * Safety:
 *   - Hostname locked to *.googlevideo.com via isAllowedProxyHost so
 *     this can't be turned into a generic open proxy.
 *   - We forward Range headers so the browser can resume / partial-
 *     fetch, and we propagate the upstream status (e.g. 206 Partial).
 *   - Client disconnect (Stop button) is observed via response.on
 *     ("close") so we can abort the upstream fetch and stop burning
 *     droplet bytes on a download nobody wants.
 */
streamRouter.get("/proxy", async (request, response) => {
  const targetRaw = request.query.url;
  if (typeof targetRaw !== "string" || targetRaw.length === 0) {
    response.status(400).json({ error: "`url` query param is required." });
    return;
  }

  let target: URL;
  try {
    target = new URL(targetRaw);
  } catch {
    response.status(400).json({ error: "`url` is not a valid URL." });
    return;
  }

  if (target.protocol !== "https:" || !isAllowedProxyHost(target.hostname)) {
    response
      .status(403)
      .json({ error: "Only https googlevideo.com URLs may be proxied." });
    return;
  }

  // AbortController is wired to the Express response's "close" event
  // so that when the user taps Stop (and the PWA cancels its fetch)
  // we tear down the upstream connection instead of letting the
  // droplet keep pulling bytes from googlevideo on their behalf.
  const upstreamAbort = new AbortController();
  response.on("close", () => {
    if (!response.writableEnded) {
      upstreamAbort.abort();
    }
  });

  try {
    const upstreamHeaders: Record<string, string> = {};
    if (typeof request.headers.range === "string") {
      upstreamHeaders.Range = request.headers.range;
    }

    const upstream = await fetch(target.toString(), {
      headers: upstreamHeaders,
      signal: upstreamAbort.signal,
    });

    response.status(upstream.status);

    // Forward upstream content headers but skip CORS / hop-by-hop —
    // our express cors middleware will inject the right values for
    // the PWA origin, and the connection-level headers don't apply
    // when we re-emit the body.
    upstream.headers.forEach((value, name) => {
      const lower = name.toLowerCase();
      if (
        lower.startsWith("access-control-") ||
        lower === "connection" ||
        lower === "transfer-encoding" ||
        lower === "keep-alive"
      ) {
        return;
      }
      response.setHeader(name, value);
    });

    if (!upstream.body) {
      response.end();
      return;
    }

    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!response.write(Buffer.from(value))) {
        // Respect TCP backpressure so we don't balloon memory if the
        // downstream consumer (slow mobile network) can't keep up.
        await new Promise<void>((resolve) =>
          response.once("drain", () => resolve()),
        );
      }
    }
    response.end();
  } catch (error) {
    if (
      (error as { name?: string })?.name === "AbortError" ||
      upstreamAbort.signal.aborted
    ) {
      // Client went away mid-stream. response.end() is implicit when
      // the connection closes; nothing more to do.
      return;
    }

    console.error("[stream proxy] upstream error:", error);
    if (!response.headersSent) {
      response.status(502).json({
        error:
          error instanceof Error ? error.message : "Stream proxy failed.",
      });
    } else {
      response.end();
    }
  }
});

export { streamRouter };
