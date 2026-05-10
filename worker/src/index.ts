// IMPORTANT: this side-effect import must come before any other import.
// `dotenv/config` calls dotenv.config() synchronously as part of being
// loaded, which populates process.env *before* the rest of the module
// graph is evaluated. The previous pattern (`import { config }` + a later
// `loadEnv()` call) ran too late: modules like ./lib/jobs read env vars
// at module-load time (e.g. const YT_DLP_COOKIES = process.env...), so
// they were captured as empty strings before dotenv had a chance to run.
import "dotenv/config";

import cors from "cors";
import express from "express";

import { startDownloadCleanupLoop } from "./lib/storage";
import { filesRouter } from "./routes/files";
import { healthRouter } from "./routes/health";
import { jobsRouter } from "./routes/jobs";

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
  console.log(`yt-dlp cookies file: ${process.env.YT_DLP_COOKIES?.trim() || "(none)"}`);
  console.log(`yt-dlp player clients: ${process.env.YT_DLP_PLAYER_CLIENTS?.trim() || "(default web_safari,tv,mweb,ios)"}`);
  console.log(`yt-dlp remote components: ${process.env.YT_DLP_REMOTE_COMPONENTS?.trim() || "(default ejs:github)"}`);
  console.log(`yt-dlp proxy: ${process.env.YT_DLP_PROXY?.trim() ? "(configured)" : "(none)"}`);
  console.log(`worker public url: ${process.env.WORKER_PUBLIC_URL?.trim() || "(derived from request)"}`);
});