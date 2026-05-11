#!/usr/bin/env node
/**
 * Build the PWA as a static export and sync it into the Capacitor
 * Android project so an APK can be built.
 *
 * Usage:
 *   npm run build:capacitor         # full: rebuild static export, then sync
 *   npm run build:capacitor -- --sync-only   # skip next build, just sync
 *
 * Why this script exists instead of `next build && cap sync`:
 *   Next.js refuses `output: 'export'` while any `app/api/* /route.ts`
 *   exists. Those routes are dev-only fallbacks that talk to the local
 *   in-process fake job runner (when NEXT_PUBLIC_WORKER_API_URL is
 *   unset), so they're harmless on Vercel but block static export.
 *   This script temporarily renames `app/api` → `app/_api_capacitor_off`
 *   for the duration of the build, then puts it back. The rename is
 *   wrapped in try/finally so an interrupted build doesn't leave the
 *   tree in a half-renamed state.
 */
import { spawn } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const API_DIR = path.join(ROOT, "app", "api");
const PARKED_API_DIR = path.join(ROOT, "app", "_api_capacitor_off");

const args = new Set(process.argv.slice(2));
const SYNC_ONLY = args.has("--sync-only");

function run(cmd, cmdArgs, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, ...env },
      shell: false,
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${cmdArgs.join(" ")} exited ${code}`));
    });
  });
}

async function withApiParked(work) {
  // Move app/api aside so `next build` with output:'export' doesn't
  // complain about non-static routes. Idempotent: if a previous run
  // crashed mid-rename, just skip the move and trust the parked
  // directory.
  let didMove = false;
  if (existsSync(API_DIR) && !existsSync(PARKED_API_DIR)) {
    renameSync(API_DIR, PARKED_API_DIR);
    didMove = true;
  }
  try {
    return await work();
  } finally {
    if (didMove && existsSync(PARKED_API_DIR) && !existsSync(API_DIR)) {
      renameSync(PARKED_API_DIR, API_DIR);
    }
  }
}

async function main() {
  if (!SYNC_ONLY) {
    console.log("[capacitor] running static export build…");
    await withApiParked(() =>
      run("npx", ["next", "build"], { NEXT_OUTPUT: "export" }),
    );
  } else {
    console.log("[capacitor] skipping build (--sync-only)");
  }

  // Bail early if android/ hasn't been added yet. We could auto-run
  // `npx cap add android` here, but it requires Android SDK / Gradle
  // download which the user should kick off intentionally the first
  // time. README walks through that one-time setup.
  if (!existsSync(path.join(ROOT, "android"))) {
    console.log("");
    console.log("[capacitor] android/ directory not found.");
    console.log("[capacitor] first-time setup:");
    console.log("[capacitor]   npx cap add android");
    console.log("[capacitor] then re-run: npm run build:capacitor");
    return;
  }

  console.log("[capacitor] syncing static export → android/app/src/main/assets/public");
  await run("npx", ["cap", "sync", "android"]);
  console.log("[capacitor] done. open in Android Studio with: npm run cap:open:android");
}

main().catch((error) => {
  console.error("[capacitor] build failed:", error.message ?? error);
  process.exit(1);
});
