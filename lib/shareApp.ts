const PEPINHO_URL = "https://pepinho.lol";

export type SharePepinhoResult = "shared" | "copied" | "fallback";

export function getPepinhoSharePayload(): { title: string; text: string; url: string } {
  return {
    title: "Pepinho Player",
    text: "Pepinho Player — search, play, and keep a library on your device.",
    url: PEPINHO_URL,
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
        text: `${payload.text} ${payload.url}`,
        url: payload.url,
        dialogTitle: "Share Pepinho Player",
      });
      return "shared";
    }
  } catch {
    // continue
  }

  try {
    await navigator.clipboard.writeText(`${payload.text} ${payload.url}`);
    return "copied";
  } catch {
    window.prompt("Copy this link:", payload.url);
    return "fallback";
  }
}
