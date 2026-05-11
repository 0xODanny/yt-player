"use client";

import { useEffect } from "react";

/**
 * iOS Safari has ignored the viewport meta `user-scalable=no` hint since
 * iOS 10 (for accessibility reasons), so when the site is opened in a
 * regular mobile browser tab (rather than as an installed PWA, where the
 * standalone display-mode locks the page automatically) the user can
 * still pinch-zoom and pan the layout.
 *
 * This component blocks the gesture/pinch interactions imperatively so
 * the browser experience matches the PWA. Desktop browser-level zoom
 * (Cmd/Ctrl + +/-/scroll-wheel) is intentionally left alone — disabling
 * that is hostile to users who actually need it.
 */
export function ViewportLock() {
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    // iOS Safari emits proprietary gesture* events when a pinch starts.
    const blockGesture = (event: Event) => {
      event.preventDefault();
    };

    // Android Chrome doesn't emit gesture* events — it pinches through
    // multi-touch touchmove. Cancelling those keeps the page locked.
    const blockMultiTouch = (event: TouchEvent) => {
      if (event.touches.length > 1) {
        event.preventDefault();
      }
    };

    // Block double-tap-to-zoom on iOS without breaking single taps.
    let lastTouchEnd = 0;
    const blockDoubleTap = (event: TouchEvent) => {
      const now = Date.now();
      if (now - lastTouchEnd <= 350) {
        event.preventDefault();
      }
      lastTouchEnd = now;
    };

    document.addEventListener("gesturestart", blockGesture, { passive: false });
    document.addEventListener("gesturechange", blockGesture, { passive: false });
    document.addEventListener("gestureend", blockGesture, { passive: false });
    document.addEventListener("touchmove", blockMultiTouch, { passive: false });
    document.addEventListener("touchend", blockDoubleTap, { passive: false });

    return () => {
      document.removeEventListener("gesturestart", blockGesture);
      document.removeEventListener("gesturechange", blockGesture);
      document.removeEventListener("gestureend", blockGesture);
      document.removeEventListener("touchmove", blockMultiTouch);
      document.removeEventListener("touchend", blockDoubleTap);
    };
  }, []);

  return null;
}
