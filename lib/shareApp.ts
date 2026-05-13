import { isAndroidNative } from "./platform";
import { isStandaloneDisplayMode } from "./pwaInstall";

const PEPINHO_URL = "https://pepinho.lol";

const SHARE_BODY =
  "Pepinho Player - Search, Download, Play, and Keep a Library of Your Favorite Media Files on your Device.";

export type SharePepinhoResult = "shared" | "copied" | "fallback";

export type ShareSurface = "android-app" | "pwa" | "browser";

export function getShareSurface(): ShareSurface {
  if (typeof window === "undefined") {
    return "browser";
  }
  if (isAndroidNative()) {
    return "android-app";
  }
  if (isStandaloneDisplayMode()) {
    return "pwa";
  }
  return "browser";
}

function shareTitleForSurface(surface: ShareSurface): string {
  if (surface === "android-app") {
    return "Pepinho Player for Android";
  }
  if (surface === "pwa") {
    return "Pepinho Player (installed)";
  }
  return "Pepinho Player";
}

export function getPepinhoSharePayload(): {
  title: string;
  text: string;
  url: string;
  dialogTitle: string;
} {
  const surface = getShareSurface();
  return {
    title: shareTitleForSurface(surface),
    text: `${SHARE_BODY}\n${PEPINHO_URL}`,
    url: PEPINHO_URL,
    dialogTitle: "Share Pepinho Player",
  };
}

/**
 * Opens the system share sheet when available (mobile / installed PWA),
 * otherwise copies the site link to the clipboard.
 */
export async function sharePepinhoApp(): Promise<SharePepinhoResult> {
  const payload = getPepinhoSharePayload();

  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    try {
      await navigator.share({
        title: payload.title,
        text: payload.text,
        url: payload.url,
      });
      return "shared";
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        return "shared";
      }
      // fall through to Capacitor / clipboard
    }
  }

  try {
    const { Capacitor } = await import("@capacitor/core");
    const { Share } = await import("@capacitor/share");
    if (Capacitor.isNativePlatform()) {
      await Share.share({
        title: payload.title,
        text: payload.text,
        url: payload.url,
        dialogTitle: payload.dialogTitle,
      });
      return "shared";
    }
  } catch {
    // continue
  }

  try {
    await navigator.clipboard.writeText(payload.text);
    return "copied";
  } catch {
    window.prompt("Copy this link:", payload.url);
    return "fallback";
  }
}
