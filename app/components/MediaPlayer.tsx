"use client";

import { useEffect, useRef, useState } from "react";

import { getItemObjectUrl, type ManifestItem } from "@/lib/library";
import { useSettings } from "@/lib/settings";

type MediaPlayerProps = {
  item: ManifestItem | null;
  onClose: () => void;
};

function isPipSupported(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  return Boolean(
    document.pictureInPictureEnabled &&
      typeof HTMLVideoElement !== "undefined" &&
      "requestPictureInPicture" in HTMLVideoElement.prototype,
  );
}

export function MediaPlayer({ item, onClose }: MediaPlayerProps) {
  const { settings } = useSettings();
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Per-session toggle. Initial value follows the global default; user can
  // override for this playback only without changing the global setting.
  const [audioOnly, setAudioOnly] = useState<boolean>(false);
  const [isPip, setIsPip] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const mediaRef = useRef<HTMLAudioElement | HTMLVideoElement | null>(null);

  // Sync the per-session audio-only with the user's preferred default
  // each time a new item opens. We only react to item id changes, not to
  // settings.audioOnlyDefault changes mid-session, so the user can flip
  // modes inside the player without being yanked back.
  useEffect(() => {
    if (!item) {
      return;
    }
    setAudioOnly(settings.audioOnlyDefault);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id]);

  // Audio elements always play with screen off; video elements get
  // suspended on most platforms when the screen locks. So when item is
  // a video AND user enabled audioOnly, render an <audio> element instead
  // of a <video>. iOS Safari and Android Chrome both happily play the
  // audio track of an mp4 via the <audio> tag.
  const useAudioElement = !!item && (item.type === "audio" || audioOnly);

  useEffect(() => {
    if (!item) {
      setObjectUrl(null);
      setError(null);
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
              ? "This item was restored from a manifest and has no file yet. Re-download it to play."
              : "Could not read the file from the library.",
          );
          return;
        }
        createdUrl = url;
        setObjectUrl(url);
      })
      .catch(() => {
        if (!cancelled) {
          setError("Could not read the file from the library.");
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
  }, [item]);

  useEffect(() => {
    if (!item) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [item, onClose]);

  // Wire the Media Session API so the lock screen / Control Center /
  // Bluetooth headphones / car play surfaces show now-playing info and
  // accept playback controls. This is what makes "screen off in the gym"
  // actually work — without it, even an <audio> element that keeps
  // playing through screen-lock has no UI for the user to pause/skip.
  useEffect(() => {
    if (!item || !objectUrl) {
      return;
    }
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
      return;
    }

    const artwork = item.thumbnail
      ? [
          {
            src: item.thumbnail,
            sizes: "512x512",
            // Most YouTube thumbnails are jpg; the browser is forgiving
            // about the declared type for artwork.
            type: "image/jpeg",
          },
        ]
      : [];

    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: item.title || "Untitled",
        artist: item.author || "YT Local Tool",
        album: item.format.toUpperCase(),
        artwork,
      });
    } catch {
      // Older browsers may throw on MediaMetadata.
    }

    const el = mediaRef.current;
    if (!el) {
      return;
    }

    const safeSet = (
      action: MediaSessionAction,
      handler: MediaSessionActionHandler | null,
    ) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        // Some actions (e.g. seekto) aren't supported on every platform.
      }
    };

    safeSet("play", () => {
      void el.play();
    });
    safeSet("pause", () => {
      el.pause();
    });
    safeSet("seekbackward", (details) => {
      const offset = details.seekOffset ?? 10;
      el.currentTime = Math.max(0, el.currentTime - offset);
    });
    safeSet("seekforward", (details) => {
      const offset = details.seekOffset ?? 10;
      el.currentTime = Math.min(el.duration || el.currentTime + offset, el.currentTime + offset);
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
      // closure doesn't fight whatever opens next.
      try {
        navigator.mediaSession.metadata = null;
        safeSet("play", null);
        safeSet("pause", null);
        safeSet("seekbackward", null);
        safeSet("seekforward", null);
        safeSet("seekto", null);
        safeSet("stop", null);
      } catch {
        // best effort
      }
    };
  }, [item, objectUrl, useAudioElement]);

  // Reflect playback state to the OS (so the lock-screen widget shows the
  // right play/pause icon).
  useEffect(() => {
    const el = mediaRef.current;
    if (!el || typeof navigator === "undefined" || !("mediaSession" in navigator)) {
      return;
    }
    const onPlay = () => {
      try {
        navigator.mediaSession.playbackState = "playing";
      } catch {
        // ignore
      }
    };
    const onPause = () => {
      try {
        navigator.mediaSession.playbackState = "paused";
      } catch {
        // ignore
      }
    };
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    return () => {
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
    };
  }, [objectUrl, useAudioElement]);

  function toggleAudioOnly() {
    setAudioOnly((current) => !current);
  }

  // Track whether the video element is currently in PiP so the button label
  // and aria-pressed state stay accurate (user might exit PiP via the
  // floating window's own close button).
  useEffect(() => {
    const el = mediaRef.current;
    if (!el || !(el instanceof HTMLVideoElement)) {
      return;
    }
    const onEnter = () => setIsPip(true);
    const onLeave = () => setIsPip(false);
    el.addEventListener("enterpictureinpicture", onEnter);
    el.addEventListener("leavepictureinpicture", onLeave);
    return () => {
      el.removeEventListener("enterpictureinpicture", onEnter);
      el.removeEventListener("leavepictureinpicture", onLeave);
    };
  }, [objectUrl, useAudioElement]);

  // Auto-Picture-in-Picture: when the page becomes hidden (user switched
  // apps or locked the screen) and we have a playing <video> element, ask
  // the browser to enter PiP so playback continues in a floating window.
  // Gated by the user's global setting. iOS Safari supports this since 14;
  // Android Chrome supports it; desktop Chrome/Edge support it.
  useEffect(() => {
    if (!settings.pipAuto) {
      return;
    }
    if (!isPipSupported()) {
      return;
    }
    if (useAudioElement) {
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
      if (document.pictureInPictureElement === el) {
        return;
      }
      el.requestPictureInPicture().catch(() => {
        // PiP can be refused — user gesture missing, OS denies, etc.
        // Failing silently is fine; standard background-pause behavior
        // takes over.
      });
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [settings.pipAuto, useAudioElement, objectUrl]);

  async function togglePip() {
    if (!isPipSupported()) {
      return;
    }
    const el = mediaRef.current;
    if (!(el instanceof HTMLVideoElement)) {
      return;
    }
    try {
      if (document.pictureInPictureElement === el) {
        await document.exitPictureInPicture();
      } else {
        await el.requestPictureInPicture();
      }
    } catch {
      // ignore — PiP can be refused for many reasons
    }
  }

  if (!item) {
    return null;
  }

  const showAudioToggle = item.type === "video";
  const showPipButton = item.type === "video" && !useAudioElement && isPipSupported();

  return (
    <div
      className="player-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Playing ${item.title}`}
      onClick={(event) => {
        if (event.target === dialogRef.current) {
          onClose();
        }
      }}
    >
      <div className="player-dialog" ref={dialogRef}>
        <header className="player-header">
          <div className="player-titles">
            <h2>{item.title}</h2>
            {item.author ? <p className="player-sub">{item.author}</p> : null}
          </div>
          <button
            type="button"
            className="player-close"
            aria-label="Close player"
            onClick={onClose}
          >
            ×
          </button>
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
            {item.type === "video"
              ? audioOnly
                ? "Plays with screen off · saves battery"
                : settings.pipAuto && isPipSupported()
                  ? "Auto-PiP on app switch · audio-only also available"
                  : "Switch to audio-only or use PiP for screen-off playback"
              : "Plays with screen off · lock-screen controls available"}
          </span>
        </div>

        <div className="player-body">
          {loading ? <p className="player-status">Loading…</p> : null}
          {error ? <p className="player-status player-error">{error}</p> : null}
          {!loading && !error && objectUrl ? (
            useAudioElement ? (
              <div className="player-audio-wrap">
                {item.thumbnail ? (
                  <img className="player-art" src={item.thumbnail} alt="" />
                ) : (
                  <div className="player-art player-art-fallback" aria-hidden>
                    {item.format.toUpperCase()}
                  </div>
                )}
                <audio
                  key={`${objectUrl}-audio`}
                  ref={(node) => {
                    mediaRef.current = node;
                  }}
                  className="player-audio"
                  src={objectUrl}
                  controls
                  autoPlay
                  preload="auto"
                />
              </div>
            ) : (
              <video
                key={`${objectUrl}-video`}
                ref={(node) => {
                  mediaRef.current = node;
                }}
                className="player-video"
                src={objectUrl}
                controls
                autoPlay
                playsInline
                preload="auto"
              />
            )
          ) : null}
        </div>
      </div>
    </div>
  );
}
