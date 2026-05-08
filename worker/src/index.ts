import "dotenv/config";

import cors from "cors";
import express from "express";

import { healthRouter } from "./routes/health";
import { jobsRouter } from "./routes/jobs";

const app = express();
const port = Number(process.env.PORT || 3001);

app.use(express.json());
app.use(
  cors({
    origin(origin, callback) {
      const allowedOrigin = process.env.ALLOWED_ORIGIN?.trim();

      if (!origin) {
        callback(null, true);
        return;
      }

      if (allowedOrigin && origin === allowedOrigin) {
        callback(null, true);
        return;
      }

      callback(new Error("CORS origin denied."));
    },
  }),
);

app.use("/health", healthRouter);
app.use("/jobs", jobsRouter);

app.use((error: Error, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  if (error.message === "CORS origin denied.") {
    response.status(403).json({ error: error.message });
    return;
  }

  response.status(500).json({ error: "Internal server error." });
});

app.listen(port, () => {
  console.log(`yt-worker listening on port ${port}`);
});