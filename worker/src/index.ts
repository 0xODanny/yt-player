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

// Trust the first proxy hop (e.g. nginx in front of the Node process on
// DigitalOcean). This makes `req.protocol` honor `X-Forwarded-Proto` so the
// `downloadUrl` we hand back to the frontend is `https://worker.pepinho.lol/...`
// instead of `http://...` when TLS is terminated upstream.
app.set("trust proxy", 1);

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
  console.log(`trust proxy: 1 (X-Forwarded-Proto honored)`);
});