import { config as loadEnv } from "dotenv";

import cors from "cors";
import express from "express";

import { startDownloadCleanupLoop } from "./lib/storage";
import { filesRouter } from "./routes/files";
import { healthRouter } from "./routes/health";
import { jobsRouter } from "./routes/jobs";

loadEnv();

const app = express();
const port = Number(process.env.PORT || 3001);

const corsOptions: cors.CorsOptions = {
  origin: process.env.ALLOWED_ORIGIN?.trim() || "http://localhost:3002",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: false,
};

app.use(express.json());
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use("/health", healthRouter);
app.use("/files", filesRouter);
app.use("/jobs", jobsRouter);

startDownloadCleanupLoop();

app.listen(port, () => {
  console.log("yt-worker startup");
  console.log(`port: ${port}`);
  console.log(`allowed origin: ${String(corsOptions.origin)}`);
  console.log(`worker api secret configured: ${Boolean(process.env.WORKER_API_SECRET?.trim())}`);
});