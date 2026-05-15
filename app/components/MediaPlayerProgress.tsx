"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

export type PlaybackProgressSnapshot = {
  current: number;
  duration: number;
  bufferedEnd: number;
  paused: boolean;
  waiting: boolean;
};

const initialProgress: PlaybackProgressSnapshot = {
  current: 0,
  duration: 0,
  bufferedEnd: 0,
  paused: true,
  waiting: false,
};

function mergeProgress(
  prev: PlaybackProgressSnapshot,
  next: PlaybackProgressSnapshot,
): PlaybackProgressSnapshot {
  if (
    Math.abs(prev.current - next.current) < 0.1 &&
    prev.duration === next.duration &&
    Math.abs(prev.bufferedEnd - next.bufferedEnd) < 0.25 &&
    prev.paused === next.paused &&
    prev.waiting === next.waiting
  ) {
    return prev;
  }
  return next;
}

function readMediaDuration(media: HTMLMediaElement): number {
  const d = media.duration;
  if (Number.isFinite(d) && d > 0 && d !== Number.POSITIVE_INFINITY) {
    return d;
  }
  try {
    if (media.seekable && media.seekable.length > 0) {
      const end = media.seekable.end(media.seekable.length - 1);
      if (Number.isFinite(end) && end > 0) {
        return end;
      }
    }
  } catch {
    // seekable can throw before any data is present
  }
  return 0;
}

function readBufferedEnd(media: HTMLMediaElement): number {
  try {
    if (media.buffered && media.buffered.length > 0) {
      return media.buffered.end(media.buffered.length - 1);
    }
  } catch {
    // ignore
  }
  return 0;
}

/**
 * Nudge playback by a signed delta in seconds (matches lock-screen seek
 * behaviour in MediaPlayer’s MediaSession handlers).
 */
export function seekMediaByDeltaSeconds(
  media: HTMLMediaElement | null,
  deltaSec: number,
): void {
  if (!media || !Number.isFinite(deltaSec) || deltaSec === 0) {
    return;
  }
  if (deltaSec < 0) {
    media.currentTime = Math.max(0, media.currentTime + deltaSec);
    return;
  }
  const d = media.duration;
  let cap: number;
  if (Number.isFinite(d) && d > 0) {
    cap = d;
  } else {
    try {
      if (media.seekable && media.seekable.length > 0) {
        cap = media.seekable.end(media.seekable.length - 1);
      } else {
        cap = media.currentTime + deltaSec;
      }
    } catch {
      cap = media.currentTime + deltaSec;
    }
  }
  media.currentTime = Math.min(media.currentTime + deltaSec, cap);
}

export function formatMediaClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "--:--";
  }
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Subscribes to media element timing for dock / stream custom chrome only.
 * Lives in a child component so ticking state does not reconcile the
 * `<audio>` / `<video>` node in the parent (avoids rhythmic main-thread work
 * that sounds like slowed or staggered playback on some engines).
 */
export function usePlaybackProgressSync(
  mediaRef: RefObject<HTMLMediaElement | null>,
  syncKey: string,
): PlaybackProgressSnapshot {
  const [dockProgress, setDockProgress] = useState(initialProgress);
  const streamWaitingRef = useRef(false);

  useEffect(() => {
    if (!syncKey) {
      return;
    }
    const el = mediaRef.current;
    if (!el) {
      return;
    }

    streamWaitingRef.current = false;

    const publishImmediate = () => {
      setDockProgress((prev) =>
        mergeProgress(prev, {
          current: el.currentTime,
          duration: readMediaDuration(el),
          bufferedEnd: readBufferedEnd(el),
          paused: el.paused,
          waiting: streamWaitingRef.current,
        }),
      );
    };

    const publishFromClock = () => {
      setDockProgress((prev) =>
        mergeProgress(prev, {
          current: el.currentTime,
          duration: readMediaDuration(el),
          bufferedEnd: readBufferedEnd(el),
          paused: el.paused,
          waiting: streamWaitingRef.current,
        }),
      );
    };

    let stallUiDebounce: number | undefined;
    const publishStallDebounced = () => {
      if (stallUiDebounce !== undefined) {
        window.clearTimeout(stallUiDebounce);
      }
      stallUiDebounce = window.setTimeout(() => {
        stallUiDebounce = undefined;
        publishImmediate();
      }, 160);
    };

    const onWaiting = () => {
      streamWaitingRef.current = true;
      publishStallDebounced();
    };
    const onPlaying = () => {
      streamWaitingRef.current = false;
      publishStallDebounced();
    };

    let seekUiDebounce: number | undefined;
    const publishSeekDebounced = () => {
      if (seekUiDebounce !== undefined) {
        window.clearTimeout(seekUiDebounce);
      }
      seekUiDebounce = window.setTimeout(() => {
        seekUiDebounce = undefined;
        publishImmediate();
      }, 80);
    };

    let loadDebounce: number | undefined;
    const publishLoadDebounced = () => {
      if (loadDebounce !== undefined) {
        window.clearTimeout(loadDebounce);
      }
      loadDebounce = window.setTimeout(() => {
        loadDebounce = undefined;
        publishImmediate();
      }, 140);
    };

    let playheadTick: number | undefined;
    const startPlayheadTick = () => {
      if (playheadTick !== undefined) {
        return;
      }
      publishFromClock();
      playheadTick = window.setInterval(publishFromClock, 480);
    };
    const stopPlayheadTick = () => {
      if (playheadTick !== undefined) {
        window.clearInterval(playheadTick);
        playheadTick = undefined;
      }
    };

    const onPlay = () => {
      publishImmediate();
      startPlayheadTick();
    };
    const onPause = () => {
      publishImmediate();
      stopPlayheadTick();
    };
    const onEnded = () => {
      stopPlayheadTick();
      publishImmediate();
    };

    publishImmediate();
    if (!el.paused) {
      startPlayheadTick();
    }

    el.addEventListener("loadedmetadata", publishImmediate);
    el.addEventListener("loadeddata", publishLoadDebounced);
    el.addEventListener("canplay", publishLoadDebounced);
    el.addEventListener("canplaythrough", publishLoadDebounced);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onEnded);
    el.addEventListener("seeked", publishSeekDebounced);
    el.addEventListener("waiting", onWaiting);
    el.addEventListener("playing", onPlaying);
    return () => {
      stopPlayheadTick();
      if (loadDebounce !== undefined) {
        window.clearTimeout(loadDebounce);
      }
      if (stallUiDebounce !== undefined) {
        window.clearTimeout(stallUiDebounce);
      }
      if (seekUiDebounce !== undefined) {
        window.clearTimeout(seekUiDebounce);
      }
      el.removeEventListener("loadedmetadata", publishImmediate);
      el.removeEventListener("loadeddata", publishLoadDebounced);
      el.removeEventListener("canplay", publishLoadDebounced);
      el.removeEventListener("canplaythrough", publishLoadDebounced);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onEnded);
      el.removeEventListener("seeked", publishSeekDebounced);
      el.removeEventListener("waiting", onWaiting);
      el.removeEventListener("playing", onPlaying);
    };
  }, [mediaRef, syncKey]);

  return dockProgress;
}

type StreamExpandedProgressChromeProps = {
  mediaRef: RefObject<HTMLMediaElement | null>;
  objectUrl: string;
  streamUrl: string;
  useAudioElement: boolean;
  skipSeconds: number;
};

export function StreamExpandedProgressChrome({
  mediaRef,
  objectUrl,
  streamUrl,
  useAudioElement,
  skipSeconds,
}: StreamExpandedProgressChromeProps) {
  const syncKey = `${objectUrl}|${streamUrl}|${useAudioElement ? "a" : "v"}`;
  const dockProgress = usePlaybackProgressSync(mediaRef, syncKey);

  const dur = dockProgress.duration;
  const cur = dockProgress.current;
  const buf = dockProgress.bufferedEnd;
  const scrubMax = Math.max(0.001, dur || buf || cur);
  const pct =
    dur > 0
      ? Math.min(100, (cur / dur) * 100)
      : scrubMax > 0.001
        ? Math.min(100, (cur / scrubMax) * 100)
        : 0;

  return (
    <div className="player-stream-chrome">
      {dockProgress.waiting && dur <= 0 ? (
        <p className="player-stream-status" aria-live="polite">
          Buffering…
        </p>
      ) : null}
      <div className="player-stream-chrome-row">
        <button
          type="button"
          className="player-seek-skip"
          aria-label={`Back ${skipSeconds} seconds`}
          title={`−${skipSeconds}s`}
          onClick={() => seekMediaByDeltaSeconds(mediaRef.current, -skipSeconds)}
        >
          −{skipSeconds}s
        </button>
        <button
          type="button"
          className="player-stream-playpause"
          aria-label={dockProgress.paused ? "Play" : "Pause"}
          onClick={() => {
            const el = mediaRef.current;
            if (!el) {
              return;
            }
            if (el.paused) {
              void el.play();
            } else {
              el.pause();
            }
          }}
        >
          {dockProgress.paused ? (
            <span className="player-dock-play-glyph" aria-hidden />
          ) : (
            <span className="player-dock-pause-glyph" aria-hidden />
          )}
        </button>
        <button
          type="button"
          className="player-seek-skip"
          aria-label={`Forward ${skipSeconds} seconds`}
          title={`+${skipSeconds}s`}
          onClick={() => seekMediaByDeltaSeconds(mediaRef.current, skipSeconds)}
        >
          +{skipSeconds}s
        </button>
        <span className="player-stream-time">
          {formatMediaClock(cur)} /{" "}
          {dur > 0 ? formatMediaClock(dur) : buf > 0 ? formatMediaClock(buf) : "--:--"}
        </span>
        <div className="player-stream-scrub">
          <div
            className={`player-dock-track${dockProgress.waiting && dur <= 0 ? " player-dock-track--busy" : ""}`}
            aria-hidden
          >
            <div className="player-dock-fill" style={{ width: `${pct}%` }} />
          </div>
          <input
            type="range"
            className="player-dock-range"
            min={0}
            max={scrubMax}
            step="any"
            value={Math.min(cur, scrubMax)}
            aria-label="Seek"
            onChange={(event) => {
              const el = mediaRef.current;
              const next = Number(event.target.value);
              if (el && Number.isFinite(next)) {
                el.currentTime = next;
              }
            }}
          />
        </div>
      </div>
    </div>
  );
}

type MinimizedProgressDockProps = {
  mediaRef: RefObject<HTMLMediaElement | null>;
  objectUrl: string;
  itemId: string;
  streamUrl: string;
  useAudioElement: boolean;
  skipSeconds: number;
  title: string;
  thumbnail?: string;
  formatLabel: string;
  onExpand: () => void;
  onClose: () => void;
};

export function MinimizedProgressDock({
  mediaRef,
  objectUrl,
  itemId,
  streamUrl,
  useAudioElement,
  skipSeconds,
  title,
  thumbnail,
  formatLabel,
  onExpand,
  onClose,
}: MinimizedProgressDockProps) {
  const syncKey = `${objectUrl}|${itemId}|${streamUrl}|${useAudioElement ? "a" : "v"}`;
  const dockProgress = usePlaybackProgressSync(mediaRef, syncKey);

  const dur = dockProgress.duration;
  const cur = dockProgress.current;
  const buf = dockProgress.bufferedEnd;
  const scrubMax = Math.max(0.001, dur || buf || cur);
  const pct =
    dur > 0
      ? Math.min(100, (cur / dur) * 100)
      : scrubMax > 0.001
        ? Math.min(100, (cur / scrubMax) * 100)
        : 0;

  return (
    <div className="player-dock" role="region" aria-label={`Now playing: ${title}`}>
      <div className="player-dock-thumb-wrap">
        {thumbnail ? (
          <img className="player-dock-thumb" src={thumbnail} alt="" />
        ) : (
          <div className="player-dock-thumb player-dock-thumb-fallback" aria-hidden>
            {formatLabel}
          </div>
        )}
      </div>
      <div className="player-dock-center">
        <p className="player-dock-title">{title}</p>
        <div className="player-dock-seek-row" role="group" aria-label="Seek">
          <button
            type="button"
            className="player-seek-skip player-seek-skip--compact"
            aria-label={`Back ${skipSeconds} seconds`}
            title={`−${skipSeconds}s`}
            onClick={() => seekMediaByDeltaSeconds(mediaRef.current, -skipSeconds)}
          >
            −{skipSeconds}s
          </button>
          <button
            type="button"
            className="player-seek-skip player-seek-skip--compact"
            aria-label={`Forward ${skipSeconds} seconds`}
            title={`+${skipSeconds}s`}
            onClick={() => seekMediaByDeltaSeconds(mediaRef.current, skipSeconds)}
          >
            +{skipSeconds}s
          </button>
        </div>
        <div className="player-dock-scrub">
          <div
            className={`player-dock-track${dockProgress.waiting && dur <= 0 ? " player-dock-track--busy" : ""}`}
            aria-hidden
          >
            <div className="player-dock-fill" style={{ width: `${pct}%` }} />
          </div>
          <input
            type="range"
            className="player-dock-range"
            min={0}
            max={scrubMax}
            step="any"
            value={Math.min(cur, scrubMax)}
            aria-label="Seek"
            onChange={(event) => {
              const el = mediaRef.current;
              const next = Number(event.target.value);
              if (el && Number.isFinite(next)) {
                el.currentTime = next;
              }
            }}
          />
        </div>
      </div>
      <div className="player-dock-actions">
        <button
          type="button"
          className="player-dock-icon-btn player-dock-playpause"
          aria-label={dockProgress.paused ? "Play" : "Pause"}
          onClick={() => {
            const el = mediaRef.current;
            if (!el) {
              return;
            }
            if (el.paused) {
              void el.play();
            } else {
              el.pause();
            }
          }}
        >
          {dockProgress.paused ? (
            <span className="player-dock-play-glyph" aria-hidden />
          ) : (
            <span className="player-dock-pause-glyph" aria-hidden />
          )}
        </button>
        <button
          type="button"
          className="player-dock-icon-btn"
          aria-label="Expand player"
          title="Full player"
          onClick={onExpand}
        >
          ⛶
        </button>
        <button
          type="button"
          className="player-dock-icon-btn player-dock-stop"
          aria-label="Stop playback"
          onClick={onClose}
        >
          ×
        </button>
      </div>
    </div>
  );
}
