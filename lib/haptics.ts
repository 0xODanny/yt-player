import { Capacitor } from "@capacitor/core";

function isAndroidNative(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

/**
 * Light impact on successful save-to-library (Android app only).
 * No-ops on web / iOS / missing plugin.
 */
export async function hapticLibrarySaveSuccess(): Promise<void> {
  if (!isAndroidNative()) {
    return;
  }
  try {
    const { Haptics, ImpactStyle } = await import("@capacitor/haptics");
    await Haptics.impact({ style: ImpactStyle.Light });
  } catch {
    // Plugin unavailable or WebView restriction
  }
}

/**
 * Slightly stronger tap when a save or download fails (Android app only).
 */
export async function hapticLibrarySaveFailure(): Promise<void> {
  if (!isAndroidNative()) {
    return;
  }
  try {
    const { Haptics, ImpactStyle } = await import("@capacitor/haptics");
    await Haptics.impact({ style: ImpactStyle.Medium });
  } catch {
    // ignore
  }
}
