#!/usr/bin/env node
/**
 * Generate the two PWA icons that Next.js serves from /public/icons.
 *
 * Run as part of `npm run assets:generate`. Reads the master image
 * from resources/logo.png and writes:
 *   public/icons/icon-192.png  (used by manifest + apple-touch-icon)
 *   public/icons/icon-512.png  (used by manifest)
 *
 * Why not delegate to @capacitor/assets --pwa?
 *   The capacitor-assets PWA generator drops everything in a top-
 *   level icons/ dir (assuming a flat web project) and rewrites
 *   manifest.json with relative ../icons/... paths and .webp files
 *   that Safari iOS doesn't reliably accept as PWA icons. Our
 *   manifest pins specific filenames (icon-192.png, icon-512.png)
 *   that the rest of the app references; this script just keeps
 *   those two files in sync with the master logo without touching
 *   the manifest schema.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const SOURCE = path.join(ROOT, "resources", "logo.png");
const OUT_DIR = path.join(ROOT, "public", "icons");

const SIZES = [192, 512];

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  for (const size of SIZES) {
    const outFile = path.join(OUT_DIR, `icon-${size}.png`);
    await sharp(SOURCE)
      .resize(size, size, { fit: "cover" })
      .png({ compressionLevel: 9 })
      .toFile(outFile);
    console.log(`[pwa-icons] wrote ${path.relative(ROOT, outFile)}`);
  }
}

main().catch((error) => {
  console.error("[pwa-icons] failed:", error);
  process.exit(1);
});
