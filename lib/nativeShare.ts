/**
 * Hand a Blob over to Android's native share sheet so the user can
 * route it to Files / Downloads / Photos / a chat app / whatever.
 *
 * The flow is:
 *   1. Read the Blob into a base64 string (Capacitor's IPC channel
 *      can't pass binary directly).
 *   2. Write it into Directory.Cache via Filesystem.writeFile so the
 *      OS has a real file:// path to share.
 *   3. Call Share.share({ url }) which pops the share sheet.
 *   4. Cache-directory file is left in place — Android will clean it
 *      up automatically, and deleting it before the share sheet
 *      finishes would yank the bytes out from under the receiving
 *      app.
 *
 * For files larger than ~50 MB the base64 conversion alone takes a
 * couple of seconds on a mid-tier phone. UI shows a brief "Preparing
 * share…" state via the caller's busy flag.
 */

import {
  Directory,
  Filesystem,
} from "@capacitor/filesystem";
import { Share } from "@capacitor/share";

import { isAndroidNative } from "./platform";

export type ShareBlobOptions = {
  /** Filename + extension the receiving app will see. */
  filename: string;
  /**
   * MIME type hint for apps that branch on type (e.g. Photos accepts
   * video/* but not application/octet-stream).
   */
  mime?: string;
  dialogTitle?: string;
};

export async function shareBlobNative(
  blob: Blob,
  options: ShareBlobOptions,
): Promise<void> {
  if (!isAndroidNative()) {
    throw new Error("shareBlobNative is only available in the Android app.");
  }

  const base64 = await blobToBase64(blob);

  // Don't write into Documents — that's user-visible and we don't
  // want to litter with temp files. Cache gets nuked by the OS.
  await Filesystem.writeFile({
    path: options.filename,
    directory: Directory.Cache,
    data: base64,
  });

  const { uri } = await Filesystem.getUri({
    path: options.filename,
    directory: Directory.Cache,
  });

  await Share.share({
    title: options.filename,
    url: uri,
    dialogTitle: options.dialogTitle ?? "Save",
  });
}

/**
 * Convert a Blob to a base64 string (no data: URI prefix). Uses
 * FileReader.readAsDataURL because it's the only fast path the
 * platform actually optimizes for — manual chunking through
 * arrayBuffer + btoa is 4-5x slower on V8 for tens of megabytes.
 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("FileReader returned non-string"));
        return;
      }
      // Strip the "data:<mime>;base64," prefix.
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader error"));
    reader.readAsDataURL(blob);
  });
}
