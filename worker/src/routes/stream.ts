import { Router } from "express";

import { requireWorkerAuth } from "../lib/auth";
import {
  getStreamUrl,
  isValidMediaSourceUrl,
  sanitizeErrorMessage,
} from "../lib/jobs";

const streamRouter = Router();

streamRouter.use(requireWorkerAuth);

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
 *
 * Note for archaeologists: this file used to expose a second route
 * `GET /stream/proxy` that byte-streamed googlevideo content back to
 * the PWA for an experimental "save without IPRoyal bandwidth"
 * feature. That feature died on YouTube's PO Token enforcement in
 * 2026 (yt-dlp no longer gets HLS for our player_clients, only the
 * legacy itag 18 URL — which has no CORS for the browser and is
 * blocked by googlevideo's ASN filter when fetched from the
 * droplet's bare IP). The proxy route was removed in the same
 * cleanup so it can't accidentally re-enter the codebase as an open
 * proxy to *.googlevideo.com. See git history if you need to
 * resurrect the design.
 */
streamRouter.post("/", async (request, response) => {
  const body = request.body as {
    url?: unknown;
    type?: unknown;
  };

  if (typeof body?.url !== "string" || !isValidMediaSourceUrl(body.url)) {
    response.status(400).json({ error: "A valid http(s) `url` is required." });
    return;
  }

  const type = body.type === "audio" ? "audio" : "video";

  try {
    const result = await getStreamUrl(body.url, type);
    response.json(result);
  } catch (error) {
    // getStreamUrl already sanitizes; we scrub once more at the
    // boundary so any path that bypasses that (e.g. a
    // normalizeMediaSourceUrl throw with the raw URL in the message)
    // can never leak proxy credentials to the PWA.
    const raw =
      error instanceof Error ? error.message : "Stream lookup failed.";
    const sanitized = sanitizeErrorMessage(raw);
    // Log the (sanitized) failure server-side so pm2 logs surfaces
    // the real reason — yt-dlp errors otherwise vanish into the
    // 502 response body. Includes the URL being resolved so we can
    // map errors back to specific videos when triaging.
    console.error(`[stream] failed for ${body.url} (type=${type}): ${sanitized}`);
    response.status(502).json({ error: sanitized });
  }
});

export { streamRouter };
