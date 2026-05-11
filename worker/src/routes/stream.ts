import { Router } from "express";

import { requireWorkerAuth } from "../lib/auth";
import { getStreamUrl, isValidMediaSourceUrl } from "../lib/jobs";

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

export { streamRouter };
