/**
 * True when the PWA is running in an installed / standalone shell
 * (Add to Home Screen, or similar). False in a regular browser tab.
 * SSR-safe.
 */
export function isStandaloneDisplayMode(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    if (window.matchMedia("(display-mode: standalone)").matches) {
      return true;
    }
    if (window.matchMedia("(display-mode: fullscreen)").matches) {
      return true;
    }
    const nav = window.navigator as Navigator & { standalone?: boolean };
    if (nav.standalone === true) {
      return true;
    }
  } catch {
    // matchMedia can throw in rare embedded contexts
  }
  return false;
}
