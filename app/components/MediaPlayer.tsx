"use client";

import { useEffect, useRef, useState } from "react";

import { getItemObjectUrl, type ManifestItem } from "@/lib/library";

type MediaPlayerProps = {
  item: ManifestItem | null;
  onClose: () => void;
};

const AUDIO_MODE_STORAGE_KEY = "yt-local-tool:audio-only-mode";

function loadAudioModePreference(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage.getItem(AUDIO_MODE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function saveAudioModePreference(enabled: boolean): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(AUDIO_MODE_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // ignore quota errors
  }
}

export function MediaPlayer({ item, onClose }: MediaPlayerProps) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [audioOnly, setAudioOnly] = useState<boolean>(() => loadAudioModePreference());
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const mediaRef = useRef<HTMLAudioElement | HTMLVideoElement | null>(null);

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
    setAudioOnly((current) => {
      const next = !current;
      saveAudioModePreference(next);
      return next;
    });
  }

  if (!item) {
    return null;
  }

  const showAudioToggle = item.type === "video";

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

        {showAudioToggle ? (
          <div className="player-toolbar">
            <button
              type="button"
              className={`player-mode${audioOnly ? " active" : ""}`}
              onClick={toggleAudioOnly}
              aria-pressed={audioOnly}
              title={audioOnly ? "Switch to video" : "Switch to audio-only"}
            >
              {audioOnly ? "Video mode" : "Audio-only"}
            </button>
            <span className="player-toolbar-hint">
              {audioOnly
                ? "Plays with screen off · saves battery"
                : "Audio-only continues playing with screen off"}
            </span>
          </div>
        ) : (
          <div className="player-toolbar">
            <span className="player-toolbar-hint">
              Plays with screen off · lock-screen controls available
            </span>
          </div>
        )}

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
