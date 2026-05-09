import { Router } from "express";

import { cleanupExpiredDownloads, ensureDownloadsDir, resolveDownloadPath } from "../lib/storage";

const filesRouter = Router();

filesRouter.get("/:filename", async (request, response) => {
  await ensureDownloadsDir();
  await cleanupExpiredDownloads();

  const filePath = resolveDownloadPath(request.params.filename);

  if (!filePath) {
    response.status(400).json({ error: "Invalid filename." });
    return;
  }

  response.setHeader(
    "Content-Disposition",
    `attachment; filename="${request.params.filename}"`,
  );

  response.sendFile(filePath, (error) => {
    if (!error) {
      return;
    }

    const fileError = error as NodeJS.ErrnoException;

    if (fileError.code === "ENOENT") {
      response.status(404).json({ error: "File not found." });
      return;
    }

    response.status(500).json({ error: "Unable to serve file." });
  });
});

export { filesRouter };