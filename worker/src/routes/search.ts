import { Router } from "express";

import { requireWorkerAuth } from "../lib/auth";
import { searchYouTube } from "../lib/jobs";

const searchRouter = Router();

searchRouter.use(requireWorkerAuth);

searchRouter.get("/", async (request, response) => {
  const rawQuery = request.query.q;
  const rawLimit = request.query.limit;

  if (typeof rawQuery !== "string" || rawQuery.trim().length === 0) {
    response.status(400).json({ error: "Query parameter `q` is required." });
    return;
  }

  const limit = typeof rawLimit === "string" ? Number(rawLimit) : 20;

  try {
    const results = await searchYouTube(rawQuery, limit);
    response.json({ results });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Search failed.";
    response.status(502).json({ error: message });
  }
});

export { searchRouter };
