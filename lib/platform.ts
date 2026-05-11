/**
 * Runtime platform detection. Used by the search UI to decide whether
 * to surface the ⬇︎ direct-download chips: those only work inside the
 * native Android Capacitor wrapper, where CapacitorHttp can fetch
 * `googlevideo.com` URLs from the device's cellular/WiFi IP without
 * the browser's CORS restrictions.
 *
 * The PWA running in any browser (Android Chrome, iOS Safari,
 * desktop) cannot do this — see git history (commit 77339ed) for the
 * full architectural argument. tl;dr: googlevideo doesn't send
 * Access-Control-Allow-Origin on itag 18, the worker can't proxy it
 * because DigitalOcean's ASN is blocklisted, and YouTube's PO Token
 * enforcement closed the HLS escape hatch in 2026.
 *
 * Capacitor injects `window.Capacitor` at runtime in native builds
 * only. The Capacitor.getPlatform() return values are "web", "ios",
 * "android" — we treat "web" the same as "no native bridge."
 */

import { Capacitor } from "@capacitor/core";

/**
 * True when the current runtime is the native Android Capacitor wrapper.
 *
 * SSR-safe: returns false during server-side rendering since
 * Capacitor.getPlatform() returns "web" without a window. The
 * isNativePlatform() guard belt-and-suspenders this — some Capacitor
 * versions injected a stub even in non-native contexts.
 */
export function isAndroidNative(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
  } catch {
    return false;
  }
}

/**
 * True when the current runtime is the native iOS Capacitor wrapper.
 * Currently always false because we don't ship an iOS app, but the
 * helper exists so we can wire it up later without scattering string
 * comparisons through the UI code.
 */
export function isIosNative(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
  } catch {
    return false;
  }
}

/**
 * True for both Android- and iOS-native wrappers.
 */
export function isNative(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}
