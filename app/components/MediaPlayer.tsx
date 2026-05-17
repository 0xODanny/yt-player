"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getItemObjectUrl, type ManifestItem } from "@/lib/library";
import { isAndroidNative } from "@/lib/platform";
import { useSettings } from "@/lib/settings";
import { type StreamSource } from "@/lib/stream";
import { MediaSession } from "@jofr/capacitor-media-session";

import type { PlaybackLayout } from "@/lib/playback";

import {
  ExpandedStageControls,
  MinimizedProgressDock,
  seekMediaByDeltaSeconds,
  StreamExpandedProgressChrome,
} from "./MediaPlayerProgress";

/**
 * Either a saved library item (plays from OPFS via a blob URL) OR a live
 * YouTube stream URL (plays directly from googlevideo.com via HTTP). The
 * player UX is identical: same controls, same lock-screen integration,
 * same PiP / audio-only toggles. Caller passes whichever shape they have.
 */
type MediaPlayerProps = {
  item: ManifestItem | null;
  stream?: StreamSource | null;
  /**
   * Optional title/author overrides used when `stream` is provided (the
   * worker doesn't always return a title for adult/non-YouTube sources).
   */
  streamMeta?: {
    title?: string;
    author?: string;
    thumbnail?: string;
  };
  layout: PlaybackLayout;
  onMinimize: () => void;
  onExpand: () => void;
  onClose: () => void;
  /**
   * Library only: loop the current file on natural end (HTMLMediaElement.loop).
   */
  repeatOne?: boolean;
  /**
   * Library only: fired once when playback reaches natural end and
   * `repeatOne` is false — used to advance to the next track in folder
   * loop-all mode.
   */
  onLibraryPlaybackEnded?: () => void;
};

// iOS Safari doesn't implement the W3C Picture-in-Picture API. Instead it
// exposes Apple's WebKit-prefixed presentation-mode API on HTMLVideoElement.
// Both must be considered for cross-platform support.
type WebKitVideoElement = HTMLVideoElement & {
  webkitSupportsPresentationMode?: (mode: "picture-in-picture") => boolean;
  webkitSetPresentationMode?: (
    mode: "inline" | "picture-in-picture" | "fullscreen",
  ) => void;
  webkitPresentationMode?: "inline" | "picture-in-picture" | "fullscreen";
};

function isStandardPipSupported(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  return Boolean(
    document.pictureInPictureEnabled &&
      typeof HTMLVideoElement !== "undefined" &&
      "requestPictureInPicture" in HTMLVideoElement.prototype,
  );
}

function isWebkitPipSupported(video: HTMLVideoElement | null): boolean {
  if (!video) {
    return false;
  }
  const v = video as WebKitVideoElement;
  return (
    typeof v.webkitSupportsPresentationMode === "function" &&
    v.webkitSupportsPresentationMode("picture-in-picture") === true
  );
}

function videoIsInPip(video: HTMLVideoElement | null): boolean {
  if (!video) {
    return false;
  }
  if (typeof document !== "undefined" && document.pictureInPictureElement === video) {
    return true;
  }
  return (video as WebKitVideoElement).webkitPresentationMode === "picture-in-picture";
}

function streamUrlLooksLikeVideo(url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  try {
    const parsed = new URL(url);
    const mime = parsed.searchParams.get("mime") || "";
    const itag = parsed.searchParams.get("itag") || "";
    return mime.startsWith("video/") || itag === "18" || itag === "22";
  } catch {
    return false;
  }
}

async function enterPip(video: HTMLVideoElement): Promise<void> {
  // Prefer WebKit's API on iOS — the standard one will throw or be missing.
  const webkit = video as WebKitVideoElement;
  if (typeof webkit.webkitSetPresentationMode === "function") {
    webkit.webkitSetPresentationMode("picture-in-picture");
    return;
  }
  if (typeof video.requestPictureInPicture === "function") {
    await video.requestPictureInPicture();
  }
}

async function exitPip(video: HTMLVideoElement): Promise<void> {
  const webkit = video as WebKitVideoElement;
  if (
    typeof webkit.webkitSetPresentationMode === "function" &&
    webkit.webkitPresentationMode === "picture-in-picture"
  ) {
    webkit.webkitSetPresentationMode("inline");
    return;
  }
  if (typeof document !== "undefined" && document.pictureInPictureElement) {
    await document.exitPictureInPicture();
  }
}

export function MediaPlayer({
  item,
  stream,
  streamMeta,
  layout,
  onMinimize,
  onExpand,
  onClose,
  repeatOne = false,
  onLibraryPlaybackEnded,
}: MediaPlayerProps) {
  const { settings, update } = useSettings();
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Per-session toggle. Initial value follows the global default; user can
  // override for this playback only without changing the global setting.
  const [audioOnly, setAudioOnly] = useState<boolean>(false);
  const [isPip, setIsPip] = useState(false);
  const [pipAvailable, setPipAvailable] = useState<boolean>(false);
  const [playbackRate, setPlaybackRate] = useState(settings.preferredPlaybackRate);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const bindAudioRef = useCallback((node: HTMLAudioElement | null) => {
    mediaRef.current = node;
  }, []);
  const bindVideoRef = useCallback((node: HTMLVideoElement | null) => {
    mediaRef.current = node;
  }, []);
  const onLibraryEndedRef = useRef(onLibraryPlaybackEnded);
  const wasPlayingBeforeBackgroundRef = useRef(false);
  onLibraryEndedRef.current = onLibraryPlaybackEnded;

  // Whichever source is set drives the player. `stream` wins if both are
  // provided, but in practice callers pass exactly one.
  const playable = stream
    ? {
        kind: "stream" as const,
        id: `stream:${stream.url.slice(0, 32)}`,
        title: stream.title || streamMeta?.title || "Streaming…",
        author: stream.author || streamMeta?.author,
        thumbnail: stream.thumbnail || streamMeta?.thumbnail,
        type: stream.type,
        format: (stream.type === "audio" ? "mp3" : "mp4") as "mp3" | "mp4",
      }
    : item
      ? {
          kind: "library" as const,
          id: item.id,
          title: item.title,
          author: item.author,
          thumbnail: item.thumbnail,
          type: item.type,
          format: item.format,
        }
      : null;

  // New source: reset per-session speed to the default.
  useEffect(() => {
    if (!playable) {
      return;
    }
    setPlaybackRate(settings.preferredPlaybackRate);
  }, [playable?.id, settings.preferredPlaybackRate, playable]);

  // On Android APK, library *video* files default to audio-only so we use
  // an <audio> element first — WebView often pauses <video> on blob URLs
  // when the screen locks. Streams still follow the global default only.
  useEffect(() => {
    if (!playable) {
      return;
    }
    const libraryVideoAndroid =
      isAndroidNative() &&
      playable.kind === "library" &&
      playable.type === "video";
    setAudioOnly(
      libraryVideoAndroid ? true : settings.audioOnlyDefault,
    );
  }, [playable?.id, settings.audioOnlyDefault, playable?.kind, playable?.type]);

  // Audio elements are best for screen-off playback, but YouTube sometimes
  // gives "audio" requests only a legacy muxed MP4 (itag 18/22). iPhone PWAs
  // are more reliable when those URLs are played through <video>.
  const streamAudioUsesVideoFallback =
    playable?.kind === "stream" &&
    playable.type === "audio" &&
    streamUrlLooksLikeVideo(stream?.url);
  const useAudioElement =
    !!playable && (playable.type === "audio" || audioOnly) && !streamAudioUsesVideoFallback;

  useEffect(() => {
    const el = mediaRef.current;
    if (!el || !objectUrl) {
      return;
    }
    el.playbackRate = playbackRate;
  }, [objectUrl, playbackRate, useAudioElement]);

  // Some browsers defer autoplay on <video> until after layout (especially
  // when controls are custom). One nudge after mount helps stream video
  // start instead of sitting on a black first frame at 0:00.
  useEffect(() => {
    if (!playable || playable.kind !== "stream" || playable.type !== "video" || useAudioElement) {
      return;
    }
    if (!objectUrl || layout !== "expanded") {
      return;
    }
    const v = mediaRef.current;
    if (!(v instanceof HTMLVideoElement)) {
      return;
    }
    const id = window.setTimeout(() => {
      if (v.paused && !v.ended) {
        void v.play().catch(() => {});
      }
    }, 80);
    return () => window.clearTimeout(id);
  }, [
    stream?.url,
    item?.id,
    useAudioElement,
    objectUrl,
    layout,
    playable?.kind,
    playable?.type,
  ]);

  useEffect(() => {
    const has = item || stream;
    if (!has || layout !== "minimized") {
      document.body.classList.remove("player-dock-visible");
    } else {
      document.body.classList.add("player-dock-visible");
    }
    return () => document.body.classList.remove("player-dock-visible");
  }, [item?.id, stream?.url, layout, item, stream]);

  useEffect(() => {
    if (!playable) {
      setObjectUrl(null);
      setError(null);
      return;
    }

    // Streams already have a directly-playable URL (a googlevideo.com
    // signed URL); no need to fetch into a blob first. Library items go
    // through OPFS to produce a blob: URL.
    if (playable.kind === "stream" && stream) {
      setObjectUrl(stream.url);
      setError(null);
      setLoading(false);
      return;
    }

    if (!item) {
      return;
    }

    let cancelled = false;
    let createdUrl: string | null = null;

    setLoading(true);
    setError(null);

    getItemObjectUrl(item)
      .then((url) => {
        if (cancelled) {
          if (url) {
            URL.revokeObjectURL(url);
          }
          return;
        }
        if (!url) {
          setError(
            item.missing
              ? "The file for this item is missing. Download it again to play."
              : "Couldn't open this file. Please try again.",
          );
          return;
        }
        createdUrl = url;
        setObjectUrl(url);
      })
      .catch(() => {
        if (!cancelled) {
          setError("Couldn't open this file. Please try again.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
    };
  }, [item, playable?.kind, stream]);

  useEffect(() => {
    if (!playable) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [playable, onClose]);

  // Wire the Media Session API so the lock screen / Control Center /
  // Bluetooth headphones / car play surfaces show now-playing info and
  // accept playback controls. This is also what makes "screen off in
  // the gym" actually work — on Android the @jofr/capacitor-media-session
  // plugin starts a foreground service when there's an active media
  // session, which prevents the WebView from being killed during long
  // background playback. On Web and iOS the plugin transparently
  // delegates to the standard navigator.mediaSession Web API.
  useEffect(() => {
    if (!playable || !objectUrl) {
      return;
    }

    const artwork = playable.thumbnail
      ? [
          {
            src: playable.thumbnail,
            sizes: "512x512",
            // Most YouTube thumbnails are jpg; the OS is forgiving about
            // the declared type for artwork.
            type: "image/jpeg",
          },
        ]
      : [];

    void MediaSession.setMetadata({
      title: playable.title || "Untitled",
      artist: playable.author || "Pepinho Player",
      album: playable.format.toUpperCase(),
      artwork,
    }).catch(() => {
      // Older browsers may reject — ignore.
    });

    const el = mediaRef.current;
    if (!el) {
      return;
    }

    type MediaAction =
      | "play"
      | "pause"
      | "seekbackward"
      | "seekforward"
      | "seekto"
      | "stop";

    const safeSet = (
      action: MediaAction,
      handler: ((details: { seekTime?: number | null; seekOffset?: number | null }) => void) | null,
    ) => {
      void MediaSession.setActionHandler({ action }, handler).catch(() => {
        // Some actions (e.g. seekto) aren't supported on every platform.
      });
    };

    safeSet("play", () => {
      void el.play();
    });
    safeSet("pause", () => {
      el.pause();
    });
    safeSet("seekbackward", (details) => {
      const offset = details.seekOffset ?? settings.skipSeconds;
      seekMediaByDeltaSeconds(el, -offset);
    });
    safeSet("seekforward", (details) => {
      const offset = details.seekOffset ?? settings.skipSeconds;
      seekMediaByDeltaSeconds(el, offset);
    });
    safeSet("seekto", (details) => {
      if (typeof details.seekTime === "number") {
        el.currentTime = details.seekTime;
      }
    });
    safeSet("stop", () => {
      el.pause();
      el.currentTime = 0;
    });

    return () => {
      // Clear handlers when this player instance goes away so a stale
      // closure doesn't fight whatever opens next, and mark playback
      // state as "none" so the foreground service can shut down.
      safeSet("play", null);
      safeSet("pause", null);
      safeSet("seekbackward", null);
      safeSet("seekforward", null);
      safeSet("seekto", null);
      safeSet("stop", null);
      void MediaSession.setPlaybackState({ playbackState: "none" }).catch(() => {
        // ignore
      });
    };
  }, [playable, objectUrl, useAudioElement, settings.skipSeconds]);

  // Reflect playback state to the OS (so the lock-screen widget shows
  // the right play/pause icon, and so the Android foreground service
  // starts/stops appropriately).
  useEffect(() => {
    const el = mediaRef.current;
    if (!el) {
      return;
    }
    let lastSessionState: "playing" | "paused" | "" = "";
    const pushSessionState = (state: "playing" | "paused") => {
      if (lastSessionState === state) {
        return;
      }
      lastSessionState = state;
      void MediaSession.setPlaybackState({ playbackState: state }).catch(() => {
        // ignore
      });
    };
    const onPlay = () => {
      pushSessionState("playing");
    };
    const onPause = () => {
      pushSessionState("paused");
    };
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    return () => {
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
    };
  }, [objectUrl, useAudioElement]);

  /**
   * Samsung / some OEMs pause WebView media when the app leaves the
   * foreground. When we come back, try to resume if playback was active.
   */
  useEffect(() => {
    if (!objectUrl) {
      return;
    }

    let removeListener: (() => void) | undefined;

    void (async () => {
      try {
        const { Capacitor } = await import("@capacitor/core");
        const { App } = await import("@capacitor/app");
        if (!Capacitor.isNativePlatform()) {
          return;
        }
        const sub = await App.addListener("appStateChange", ({ isActive }) => {
          const el = mediaRef.current;
          if (!isActive) {
            if (el && !el.paused && !el.ended) {
              wasPlayingBeforeBackgroundRef.current = true;
            }
            return;
          }
          if (
            el &&
            wasPlayingBeforeBackgroundRef.current &&
            el.paused &&
            !el.ended
          ) {
            void el.play().catch(() => undefined);
          }
          wasPlayingBeforeBackgroundRef.current = false;
        });
        removeListener = () => {
          void sub.remove();
        };
      } catch {
        // Web or incomplete native install — skip
      }
    })();

    return () => {
      removeListener?.();
    };
  }, [objectUrl, useAudioElement]);

  // Persist playback position to localStorage every few seconds so a
  // crash, OOM kill, or app re-launch returns the user to roughly where
  // they were — within a 5-second window. The position is keyed on
  // playable.id so library items and streams have stable, non-colliding
  // entries. We clear the entry on natural "ended" so finished tracks
  // don't seek the user 30 seconds before the end next time they tap
  // play.
  useEffect(() => {
    if (!playable || !objectUrl) {
      return;
    }
    const el = mediaRef.current;
    if (!el) {
      return;
    }
    const storageKey = `yt-local-tool:position:${playable.id}`;

    const writePosition = () => {
      const t = el.currentTime;
      if (Number.isFinite(t) && t > 1) {
        try {
          window.localStorage.setItem(storageKey, String(t));
        } catch {
          // quota / private mode — ignore
        }
      }
    };

    let timer: number | null = null;
    const onPlay = () => {
      if (timer != null) return;
      timer = window.setInterval(writePosition, 5000);
    };
    const onPauseOrHide = () => {
      writePosition();
      if (timer != null) {
        window.clearInterval(timer);
        timer = null;
      }
    };
    const onEnded = () => {
      onPauseOrHide();
      try {
        window.localStorage.removeItem(storageKey);
      } catch {
        // ignore
      }
      if (
        playable?.kind === "library" &&
        !repeatOne &&
        onLibraryEndedRef.current
      ) {
        onLibraryEndedRef.current();
      }
    };

    const restorePosition = () => {
      try {
        const saved = window.localStorage.getItem(storageKey);
        if (!saved) return;
        const seconds = Number(saved);
        if (!Number.isFinite(seconds) || seconds <= 1) return;
        const duration = el.duration;
        const target =
          Number.isFinite(duration) && duration > 0
            ? Math.min(seconds, duration - 1)
            : seconds;
        if (target > 1) {
          el.currentTime = target;
        }
      } catch {
        // ignore
      }
    };

    if (el.readyState >= 1) {
      restorePosition();
    } else {
      el.addEventListener("loadedmetadata", restorePosition, { once: true });
    }

    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPauseOrHide);
    el.addEventListener("ended", onEnded);
    window.addEventListener("pagehide", onPauseOrHide);

    return () => {
      onPauseOrHide();
      el.removeEventListener("loadedmetadata", restorePosition);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPauseOrHide);
      el.removeEventListener("ended", onEnded);
      window.removeEventListener("pagehide", onPauseOrHide);
    };
  }, [playable, objectUrl, useAudioElement, repeatOne]);

  // Request a screen Wake Lock while audio is playing. The Wake Lock
  // API is a "screen" lock in the browser, which on Android also keeps
  // the JS process and audio pipeline less likely to be aggressively
  // suspended by Doze. iOS Safari doesn't expose Wake Lock at all (the
  // page is silently allowed to keep audio going), so the try/catch
  // around the request keeps us crash-free everywhere. The lock is
  // automatically released when the page becomes hidden, so we
  // re-acquire on visibilitychange when the page comes back and audio
  // is still playing.
  useEffect(() => {
    if (typeof navigator === "undefined") {
      return;
    }
    const nav = navigator as Navigator & {
      wakeLock?: {
        request: (type: "screen") => Promise<WakeLockSentinel>;
      };
    };
    if (!nav.wakeLock) {
      return;
    }
    const el = mediaRef.current;
    if (!el) {
      return;
    }

    let sentinel: WakeLockSentinel | null = null;

    const acquire = async () => {
      if (sentinel) return;
      try {
        sentinel = await nav.wakeLock!.request("screen");
        sentinel.addEventListener("release", () => {
          sentinel = null;
        });
      } catch {
        // Permission denied / not allowed — silently skip; audio still works.
      }
    };
    const release = () => {
      if (!sentinel) return;
      const s = sentinel;
      sentinel = null;
      void s.release().catch(() => {
        // ignore
      });
    };

    const onPlay = () => {
      void acquire();
    };
    const onPause = () => {
      release();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible" && !el.paused) {
        void acquire();
      }
    };

    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onPause);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onPause);
      document.removeEventListener("visibilitychange", onVisibility);
      release();
    };
  }, [objectUrl, useAudioElement]);

  function toggleAudioOnly() {
    setAudioOnly((current) => !current);
  }

  // Track whether the video element is currently in PiP so the button label
  // and aria-pressed state stay accurate (user might exit PiP via the
  // floating window's own close button). Listens to both the standard
  // events (Chrome/Edge) and Apple's webkitpresentationmodechanged event.
  // Also probes for PiP support at this point — for iOS the support check
  // requires the actual video element to exist.
  useEffect(() => {
    const el = mediaRef.current;
    if (!el || !(el instanceof HTMLVideoElement)) {
      setPipAvailable(false);
      return;
    }
    setPipAvailable(isStandardPipSupported() || isWebkitPipSupported(el));
    const onEnter = () => setIsPip(true);
    const onLeave = () => setIsPip(false);
    const onWebkitChange = () => setIsPip(videoIsInPip(el));
    el.addEventListener("enterpictureinpicture", onEnter);
    el.addEventListener("leavepictureinpicture", onLeave);
    el.addEventListener("webkitpresentationmodechanged", onWebkitChange as EventListener);
    return () => {
      el.removeEventListener("enterpictureinpicture", onEnter);
      el.removeEventListener("leavepictureinpicture", onLeave);
      el.removeEventListener(
        "webkitpresentationmodechanged",
        onWebkitChange as EventListener,
      );
    };
  }, [objectUrl, useAudioElement]);

  // Auto-Picture-in-Picture: when the page becomes hidden (user switched
  // apps or locked the screen) and we have a playing <video> element, ask
  // the browser to enter PiP so playback continues in a floating window.
  //
  // On iOS Safari we ALSO set the `autoPictureInPicture` attribute on the
  // video element below — that's the only way to get OS-driven auto-PiP on
  // iPhone (Safari ignores programmatic webkitSetPresentationMode without
  // a user gesture). On other platforms we drive it from visibilitychange.
  useEffect(() => {
    if (!settings.pipAuto || useAudioElement) {
      return;
    }

    const onVisibilityChange = () => {
      if (document.visibilityState !== "hidden") {
        return;
      }
      const el = mediaRef.current;
      if (!(el instanceof HTMLVideoElement)) {
        return;
      }
      if (el.paused || el.ended) {
        return;
      }
      if (videoIsInPip(el)) {
        return;
      }
      void enterPip(el).catch(() => {
        // PiP can be refused — user gesture missing, OS denies, etc.
        // Failing silently is fine; the lock-screen Now Playing widget
        // (Media Session) still takes over for audio.
      });
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [settings.pipAuto, useAudioElement, objectUrl]);

  // Set / unset the iOS-specific autoPictureInPicture attribute when the
  // setting flips. React doesn't pass through unknown HTML attributes for
  // SSR safety, so we reflect it manually on the live DOM node.
  useEffect(() => {
    const el = mediaRef.current;
    if (!el || !(el instanceof HTMLVideoElement)) {
      return;
    }
    if (settings.pipAuto && !useAudioElement) {
      el.setAttribute("autopictureinpicture", "");
      // Apple's IDL property name is camelCased.
      try {
        (el as unknown as { autoPictureInPicture?: boolean }).autoPictureInPicture = true;
      } catch {
        // ignore — only Safari implements this property
      }
    } else {
      el.removeAttribute("autopictureinpicture");
      try {
        (el as unknown as { autoPictureInPicture?: boolean }).autoPictureInPicture = false;
      } catch {
        // ignore
      }
    }
  }, [settings.pipAuto, useAudioElement, objectUrl]);

  async function togglePip() {
    const el = mediaRef.current;
    if (!(el instanceof HTMLVideoElement)) {
      return;
    }
    try {
      if (videoIsInPip(el)) {
        await exitPip(el);
      } else {
        await enterPip(el);
      }
    } catch {
      // ignore — PiP can be refused for many reasons
    }
  }

  if (!playable) {
    return null;
  }

  const showAudioToggle = playable.type === "video";
  const showPipButton = playable.type === "video" && !useAudioElement && pipAvailable;
  const isStreaming = playable.kind === "stream";
  const expanded = layout === "expanded";
  const showNativeMediaControls = false;
  const handlePlaybackRateChange = (next: number) => {
    setPlaybackRate(next);
    update("preferredPlaybackRate", next as never);
  };

  return (
    <>
      <div
        className={`player-overlay${layout === "minimized" ? " player-overlay--minimized" : ""}`}
        role="dialog"
        aria-modal={expanded}
        aria-hidden={!expanded}
        aria-label={`Playing ${playable.title}`}
        onClick={(event) => {
          if (!expanded) {
            return;
          }
          if (event.target === dialogRef.current) {
            onClose();
          }
        }}
      >
        <div className="player-dialog" ref={dialogRef}>
          <header className="player-header">
            <div className="player-titles">
              <h2>{playable.title}</h2>
              {playable.author ? <p className="player-sub">{playable.author}</p> : null}
              {isStreaming ? (
                <p className="player-stream-tag" aria-label="Streaming directly from YouTube">
                  ● Streaming · ad-free
                </p>
              ) : null}
            </div>
            <div className="player-header-actions">
              {expanded ? (
                <button
                  type="button"
                  className="player-minimize"
                  aria-label="Minimize player"
                  title="Keep playing while you browse"
                  onClick={onMinimize}
                >
                  <span aria-hidden>▁</span>
                </button>
              ) : null}
              {expanded ? (
                <button
                  type="button"
                  className="player-close"
                  aria-label="Close player"
                  onClick={onClose}
                >
                  ×
                </button>
              ) : null}
            </div>
          </header>

          <div className="player-toolbar">
            {showAudioToggle ? (
              <button
                type="button"
                className={`player-mode${audioOnly ? " active" : ""}`}
                onClick={toggleAudioOnly}
                aria-pressed={audioOnly}
                title={audioOnly ? "Switch to video" : "Switch to audio-only"}
              >
                {audioOnly ? "Video mode" : "Audio-only"}
              </button>
            ) : null}
            {showPipButton ? (
              <button
                type="button"
                className={`player-mode${isPip ? " active" : ""}`}
                onClick={() => void togglePip()}
                aria-pressed={isPip}
                title={isPip ? "Exit Picture-in-Picture" : "Picture-in-Picture"}
              >
                {isPip ? "Exit PiP" : "Picture-in-Picture"}
              </button>
            ) : null}
            <span className="player-toolbar-hint">
              {playable.type === "video"
                ? audioOnly
                  ? "Plays with screen off · saves battery"
                  : settings.pipAuto && pipAvailable
                    ? "Auto-PiP when you swipe up · audio-only also available"
                    : pipAvailable
                      ? "Switch to audio-only or use PiP for screen-off playback"
                      : "Switch to audio-only for screen-off playback"
                : "Plays with screen off · lock-screen controls available"}
              {isAndroidNative() && playable.type === "video" && !audioOnly
                ? " On Android, use Audio-only or press Home — swiping the app away can stop playback on some phones."
                : null}
            </span>
          </div>

          <div className="player-body">
            {loading ? <p className="player-status">Loading…</p> : null}
            {error ? <p className="player-status player-error">{error}</p> : null}
            {!loading && !error && objectUrl ? (
              useAudioElement ? (
                <div className="player-audio-wrap">
                  <div className="player-media-stage">
                    {playable.thumbnail ? (
                      <img className="player-art" src={playable.thumbnail} alt="" />
                    ) : (
                      <div className="player-art player-art-fallback" aria-hidden>
                        {playable.format.toUpperCase()}
                      </div>
                    )}
                    <audio
                      key={`${objectUrl}-audio`}
                      ref={bindAudioRef}
                      className={`player-audio${isStreaming ? " player-audio--stream" : ""}`}
                      src={objectUrl}
                      controls={showNativeMediaControls}
                      autoPlay
                      preload="auto"
                      loop={repeatOne}
                    />
                    {expanded ? (
                      <ExpandedStageControls
                        mediaRef={mediaRef}
                        objectUrl={objectUrl}
                        streamUrl={stream?.url ?? ""}
                        useAudioElement={useAudioElement}
                        skipSeconds={settings.skipSeconds}
                        playbackRate={playbackRate}
                        onPlaybackRateChange={handlePlaybackRateChange}
                      />
                    ) : null}
                  </div>
                  {expanded ? (
                    <StreamExpandedProgressChrome
                      mediaRef={mediaRef}
                      objectUrl={objectUrl}
                      streamUrl={stream?.url ?? ""}
                      useAudioElement={useAudioElement}
                    />
                  ) : null}
                </div>
              ) : (
                <div className="player-stream-video-shell">
                  <div className="player-media-stage">
                    <video
                      key={`${objectUrl}-video`}
                      ref={bindVideoRef}
                      className={`player-video${isStreaming ? " player-video--stream" : ""}`}
                      src={objectUrl}
                      controls={showNativeMediaControls}
                      autoPlay
                      playsInline
                      preload="auto"
                      loop={repeatOne}
                    />
                    {expanded ? (
                      <ExpandedStageControls
                        mediaRef={mediaRef}
                        objectUrl={objectUrl}
                        streamUrl={stream?.url ?? ""}
                        useAudioElement={useAudioElement}
                        skipSeconds={settings.skipSeconds}
                        playbackRate={playbackRate}
                        onPlaybackRateChange={handlePlaybackRateChange}
                      />
                    ) : null}
                  </div>
                  {expanded ? (
                    <StreamExpandedProgressChrome
                      mediaRef={mediaRef}
                      objectUrl={objectUrl}
                      streamUrl={stream?.url ?? ""}
                      useAudioElement={useAudioElement}
                    />
                  ) : null}
                </div>
              )
            ) : null}
          </div>
        </div>
      </div>

      {layout === "minimized" && objectUrl ? (
        <MinimizedProgressDock
          mediaRef={mediaRef}
          objectUrl={objectUrl}
          itemId={item?.id ?? ""}
          streamUrl={stream?.url ?? ""}
          useAudioElement={useAudioElement}
          skipSeconds={settings.skipSeconds}
          title={playable.title}
          thumbnail={playable.thumbnail}
          formatLabel={playable.format.toUpperCase()}
          onExpand={onExpand}
          onClose={onClose}
        />
      ) : null}
    </>
  );
}
