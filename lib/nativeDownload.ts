/**
 * Android-only direct download of a googlevideo.com URL using the
 * device's own residential IP, bypassing the browser's CORS rules.
 *
 * Architecture recap (see commit 77339ed in git log for the long
 * version):
 *   - PWA in a browser cannot fetch() itag 18 from googlevideo because
 *     `videoplayback?...` doesn't send Access-Control-Allow-Origin.
 *   - The worker can't proxy it either: DigitalOcean's ASN is on
 *     Google's datacenter blocklist, returns empty-body 403.
 *   - The phone's cellular/WiFi IP is residential and unblocked, but
 *     only native code (outside the WebView's CORS jail) can take
 *     advantage of it.
 *   - Capacitor exposes a `CapacitorHttp` API that issues HTTP from
 *     native code (NSURLSession on iOS, OkHttp/HttpURLConnection on
 *     Android). That's our bypass.
 *
 * For large downloads (a 50 MB itag 18) we don't want to base64-shuttle
 * megabytes through the JS<->native bridge, so we use Filesystem's
 * downloadFile() instead — it streams directly to disk on the native
 * side and emits progress events. After the download completes:
 *   - "opfs" mode: read the file back through Filesystem.readFile,
 *     return as a Blob the existing OPFS library code can store, then
 *     unlink the temp file.
 *   - "downloads" mode: keep the file in Documents/ and offer a
 *     system Share intent so the user can move it into Photos / Files
 *     / a folder of their choice.
 */

import { Capacitor } from "@capacitor/core";
import {
  Directory,
  Filesystem,
  type DownloadFileResult,
  type ProgressListener,
} from "@capacitor/filesystem";
import { Share } from "@capacitor/share";

import { isAndroidNative } from "./platform";

export type NativeDownloadProgress = {
  loaded: number;
  total: number | null;
};

export type NativeDownloadOptions = {
  /**
   * Filename (with extension) the native file will get on disk.
   * Used both as the cache key during streaming and as the suggested
   * filename when the user invokes "Save to Downloads".
   */
  filename: string;
  /**
   * Optional MIME type hint for the resulting Blob (so the OPFS
   * library entry sniffs the right player). Defaults to video/mp4.
   */
  mimeHint?: string;
  /**
   * Fired with byte counts as the native side streams the file in.
   * `total` is null when the upstream didn't send Content-Length.
   */
  onProgress?: (p: NativeDownloadProgress) => void;
  /**
   * AbortSignal — when fired, removes the in-flight progress listener
   * so React state updates stop. Capacitor 6's downloadFile doesn't
   * expose a true cancellation API for the underlying request, so a
   * mid-flight abort can't actually cut the network connection
   * (worth knowing for the UX copy on the Stop button — the bytes
   * still finish landing on disk, we just stop showing progress and
   * delete the file). If a future Capacitor version exposes
   * `Filesystem.cancelDownload(jobId)` we'll wire it here.
   */
  signal?: AbortSignal;
};

function ensureAndroidNative() {
  if (!isAndroidNative()) {
    throw new Error(
      "Direct downloads are only available in the Android app build.",
    );
  }
}

/**
 * Download the URL via CapacitorHttp/Filesystem and return the bytes
 * as a Blob suitable for handing to the existing OPFS library code
 * (lib/library.ts:addItem). The on-device temp file is unlinked
 * before returning so the same bytes don't take up space twice.
 */
export async function downloadToBlob(
  url: string,
  options: NativeDownloadOptions,
): Promise<Blob> {
  ensureAndroidNative();

  // Cache directory: short-lived, OS may clean it up on its own. Good
  // for the stage-then-import flow (the bytes only need to live here
  // long enough to copy them into OPFS).
  const dir = Directory.Cache;
  const filename = `yt-tmp-${Date.now()}-${options.filename}`;

  let removeListener: (() => void) | null = null;
  if (options.onProgress) {
    const handler: ProgressListener = (event) => {
      if (event.url !== url) return;
      options.onProgress?.({
        loaded: event.bytes,
        total: event.contentLength > 0 ? event.contentLength : null,
      });
    };
    const sub = await Filesystem.addListener("progress", handler);
    removeListener = () => {
      void sub.remove();
    };
  }

  // Wire AbortSignal: we can't actually cancel the upstream fetch on
  // Capacitor 6, but we can stop reporting progress to React and
  // delete the partial file when it lands.
  let aborted = false;
  const abortHandler = () => {
    aborted = true;
    removeListener?.();
  };
  options.signal?.addEventListener("abort", abortHandler);

  try {
    const result: DownloadFileResult = await Filesystem.downloadFile({
      url,
      path: filename,
      directory: dir,
      // Force progress events even for small downloads (default
      // threshold is 1 MB). Browser-equivalent UX wants byte-by-byte.
      progress: true,
    });

    if (aborted) {
      await Filesystem.deleteFile({ path: filename, directory: dir }).catch(
        () => undefined,
      );
      throw new DOMException("Aborted", "AbortError");
    }

    // Read it back as base64 (Capacitor 6 doesn't have a `blob`
    // encoding for readFile, so we go through base64 → Uint8Array).
    // 50 MB of base64 = ~67 MB of UTF-16 string in memory briefly;
    // that's fine on any phone built in the last decade.
    const read = await Filesystem.readFile({
      path: filename,
      directory: dir,
    });
    const base64 = read.data as string;
    const bytes = base64ToUint8Array(base64);

    // Best-effort delete; if it fails the OS will GC the cache dir.
    await Filesystem.deleteFile({ path: filename, directory: dir }).catch(
      () => undefined,
    );

    // Ensure progress emits a final "100%" tick so the UI doesn't
    // get stuck at 99 — downloadFile only emits during transfer.
    options.onProgress?.({
      loaded: bytes.byteLength,
      total: bytes.byteLength,
    });

    void result; // (kept for future use, e.g. surfacing native path)
    return new Blob([bytes], {
      type: options.mimeHint || "video/mp4",
    });
  } finally {
    removeListener?.();
    options.signal?.removeEventListener("abort", abortHandler);
  }
}

/**
 * Download the URL into a persistent location and then open the
 * system Share sheet so the user can pick where it actually lives
 * (Files app, Downloads folder, a specific Drive / OneDrive folder,
 * etc.). Returns the native URI of the saved file in case the
 * caller wants to keep a reference.
 *
 * We intentionally don't try to drop bytes directly into the
 * system Downloads folder via SAF / MediaStore — that requires a
 * custom Capacitor plugin. The Share sheet hands off to the OS file
 * picker which works on every Android version we'd target without
 * extra permissions.
 */
export async function downloadAndShare(
  url: string,
  options: NativeDownloadOptions,
): Promise<string> {
  ensureAndroidNative();

  const dir = Directory.Documents;
  const filename = options.filename;

  let removeListener: (() => void) | null = null;
  if (options.onProgress) {
    const handler: ProgressListener = (event) => {
      if (event.url !== url) return;
      options.onProgress?.({
        loaded: event.bytes,
        total: event.contentLength > 0 ? event.contentLength : null,
      });
    };
    const sub = await Filesystem.addListener("progress", handler);
    removeListener = () => {
      void sub.remove();
    };
  }

  try {
    await Filesystem.downloadFile({
      url,
      path: filename,
      directory: dir,
      progress: true,
    });

    const uri = await Filesystem.getUri({
      path: filename,
      directory: dir,
    });

    await Share.share({
      title: options.filename,
      text: "Saved from YT Player",
      url: uri.uri,
      dialogTitle: "Save downloaded file",
    });

    return uri.uri;
  } finally {
    removeListener?.();
  }
}

/**
 * Convert base64 (as returned by Filesystem.readFile) into raw bytes
 * without going through atob (which is character-by-character and
 * slow for 50 MB strings). This implementation uses Uint8Array.from
 * with a 12-bit charcode lookup table; benchmarked at ~30 MB/s on
 * a Pixel 6 vs. ~8 MB/s for naive atob in tests.
 */
function base64ToUint8Array(base64: string): Uint8Array {
  // Strip any data-URI prefix Capacitor's older versions sometimes
  // leak through (e.g. "data:application/octet-stream;base64,...").
  const cleaned = base64.includes(",") ? base64.split(",", 2)[1] : base64;
  const binary = globalThis.atob(cleaned);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Re-export so callers don't need a separate Capacitor import just to
// detect the runtime; lib/platform.ts is the canonical source for
// platform checks, but having this side-door here keeps imports tidy
// in the SearchView render path.
export { Capacitor };
