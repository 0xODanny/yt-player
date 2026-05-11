import path from "path";
import { fileURLToPath } from "url";

import type { NextConfig } from "next";

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirPath = path.dirname(currentFilePath);

// When packaging the PWA into a Capacitor Android app we need a fully
// static export (HTML + JS + CSS only). The Vercel deploy stays as the
// default server build so the dev-only /api/* fallback routes work
// when someone clones the repo without a worker handy.
//
// Flipped on by scripts/build-capacitor.mjs setting NEXT_OUTPUT=export
// before running `next build`.
const isStaticExport = process.env.NEXT_OUTPUT === "export";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: currentDirPath,
  ...(isStaticExport
    ? {
        output: "export",
        // next/image's default loader requires a server — disable it
        // for the static bundle so <Image> tags fall back to plain
        // <img> behavior at build time.
        images: { unoptimized: true },
        // Capacitor serves the bundle from android_asset:// with no
        // server-side routing, so trailing slashes let the Android
        // WebView resolve nested routes to their index.html.
        trailingSlash: true,
      }
    : {}),
};

export default nextConfig;
