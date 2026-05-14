import type { SearchPreset } from "@/lib/settings";

/**
 * Worker-side “save to library” jobs (MP3 + fixed-res video) tunnel the
 * full file through yt-dlp while `YT_DLP_PROXY` is set — that burns
 * IPRoyal (or any residential) quota fast.
 *
 * Streaming presets (`stream-audio` / `stream-video`) only pay a small
 * metadata round-trip on the worker; media bytes go phone ↔ googlevideo.
 * Android `direct-*` saves still hit the worker once for the signed URL,
 * then bytes go phone ↔ googlevideo — much cheaper than a full worker
 * pull.
 *
 * ---------------------------------------------------------------------------
 * REACTIVATION: set the flag below to `true`, then restore the Search chips
 * / enable the `<option>`s in Settings. No other code paths need to be
 * deleted — `presetToJobPayload` and the job API stay as-is.
 * ---------------------------------------------------------------------------
 */
export const REACTIVATE_IPROYAL_HEAVY_WORKER_DOWNLOADS = false;

export function isIpRoyalHeavyWorkerDownloadPreset(
  preset: SearchPreset | string,
): boolean {
  if (preset === "mp3") {
    return true;
  }
  if (
    preset === "video-144p" ||
    preset === "video-240p" ||
    preset === "video-360p" ||
    preset === "video-720p" ||
    preset === "video-1080p"
  ) {
    return true;
  }
  return false;
}

/** True when this preset should appear disabled in Settings / menus. */
export function isIpRoyalHeavyDownloadDisabledInUi(value: string): boolean {
  if (REACTIVATE_IPROYAL_HEAVY_WORKER_DOWNLOADS) {
    return false;
  }
  return isIpRoyalHeavyWorkerDownloadPreset(value);
}
