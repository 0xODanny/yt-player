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

import { buildAllowedOrigins } from "./lib/corsOrigins";
import { startDownloadCleanupLoop } from "./lib/storage";
import { diagRouter } from "./routes/diag";
import { filesRouter } from "./routes/files";
import { healthRouter } from "./routes/health";
import { jobsRouter } from "./routes/jobs";
import { searchRouter } from "./routes/search";
import { streamRouter } from "./routes/stream";

const app = express();
const port = Number(process.env.PORT || 3001);

// ALLOWED_ORIGIN supports a comma-separated list so the same worker
// can serve the Vercel PWA (https://yt-player-ruby.vercel.app), the
// custom-domain PWA (https://pepinho.lol), and the native Android
// Capacitor wrapper. Capacitor 6's WebView with androidScheme="https"
// reports its origin as exactly `https://localhost` for every API
// request — that origin needs to be in the allow-list or the
// preflight OPTIONS fails and the actual call never runs.
//
// buildAllowedOrigins() also appends https://pepinho.lol and
// https://www.pepinho.lol so www vs apex installs both work even if
// env only listed one (see worker/src/lib/corsOrigins.ts).
const allowedOrigins = buildAllowedOrigins();

const corsOptions: cors.CorsOptions = {
  origin(origin, callback) {
    // Allow same-origin / non-browser callers (no Origin header at
    // all, e.g. curl, server-to-server, the worker hitting itself).
    if (!origin) {
      callback(null, true);
      return;
    }
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error(`Origin not allowed: ${origin}`));
  },
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
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

// Minimal request logger so pm2 logs shows every hit. Helps when the
// phone reports an error but the route handler swallowed the actual
// reason. Mounted AFTER cors() so CORS preflight rejections still
// happen earlier and OPTIONS noise is mostly filtered out at this
// layer (cors() short-circuits OPTIONS without invoking next()).
app.use((req, res, next) => {
  const origin = req.get("origin") ?? "(none)";
  console.log(`[req] ${req.method} ${req.path} origin=${origin}`);
  res.on("finish", () => {
    if (res.statusCode >= 400) {
      console.log(
        `[res] ${req.method} ${req.path} → ${res.statusCode}`,
      );
    }
  });
  next();
});

app.use("/health", healthRouter);
app.use("/diag", diagRouter);
app.use("/files", filesRouter);
app.use("/jobs", jobsRouter);
app.use("/search", searchRouter);
app.use("/stream", streamRouter);

startDownloadCleanupLoop();

app.listen(port, () => {
  console.log("yt-worker startup");
  console.log(`port: ${port}`);
  console.log(`allowed origins: ${allowedOrigins.join(", ")}`);
  console.log(`worker api secret configured: ${Boolean(process.env.WORKER_API_SECRET?.trim())}`);
  console.log(`trust proxy: 1 (X-Forwarded-Proto honored)`);
  console.log(`yt-dlp cookies file: ${process.env.YT_DLP_COOKIES?.trim() || "(none)"}`);
  console.log(`yt-dlp player clients: ${process.env.YT_DLP_PLAYER_CLIENTS?.trim() || "(default web_safari,tv,mweb,ios)"}`);
  console.log(`yt-dlp remote components: ${process.env.YT_DLP_REMOTE_COMPONENTS?.trim() || "(default ejs:github)"}`);
  console.log(`yt-dlp proxy: ${process.env.YT_DLP_PROXY?.trim() ? "(configured)" : "(none)"}`);
  console.log(`worker public url: ${process.env.WORKER_PUBLIC_URL?.trim() || "(derived from request)"}`);
});