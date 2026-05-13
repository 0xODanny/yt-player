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
  env: {
    NEXT_PUBLIC_APP_RELEASE_VERSION:
      process.env.NEXT_PUBLIC_APP_RELEASE_VERSION ??
      process.env.npm_package_version ??
      "0.1.0",
    NEXT_PUBLIC_BUILD_GIT_SHA:
      process.env.NEXT_PUBLIC_BUILD_GIT_SHA ??
      process.env.VERCEL_GIT_COMMIT_SHA ??
      process.env.GITHUB_SHA ??
      "",
  },
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
    : {
        /**
         * Force a single canonical origin on Vercel. Without this rule,
         * https://pepinho.lol and https://www.pepinho.lol both serve
         * the full app — and because OPFS, localStorage, IndexedDB and
         * `navigator.storage.persist()` grants are all scoped to the
         * exact origin, anyone who installs the PWA from one host and
         * later visits the other gets a blank library: their files
         * still exist, but they're locked away on the other origin.
         *
         * 308 Permanent Redirect (not 301) so non-GET requests preserve
         * their method (`POST /jobs` etc. survives the redirect intact
         * even if a client somehow lands on www first).
         *
         * Caveat for already-installed PWAs at www: this redirect
         * pushes them out of standalone-app scope on every relaunch
         * (iOS opens the redirected URL in Safari instead of the PWA
         * shell). Those installs were already broken — their data
         * lives on the wrong origin and the user reported them empty.
         * Reinstalling at the canonical host fixes them permanently.
         */
        async redirects() {
          return [
            {
              source: "/:path*",
              has: [{ type: "host", value: "www.pepinho.lol" }],
              destination: "https://pepinho.lol/:path*",
              permanent: true,
            },
          ];
        },
      }),
};

export default nextConfig;
