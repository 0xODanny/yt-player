"use client";

import { useEffect, useRef, useState } from "react";

import { getItemObjectUrl, type ManifestItem } from "@/lib/library";

type MediaPlayerProps = {
  item: ManifestItem | null;
  onClose: () => void;
};

export function MediaPlayer({ item, onClose }: MediaPlayerProps) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);

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

  if (!item) {
    return null;
  }

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

        <div className="player-body">
          {loading ? <p className="player-status">Loading…</p> : null}
          {error ? <p className="player-status player-error">{error}</p> : null}
          {!loading && !error && objectUrl ? (
            item.type === "video" ? (
              <video
                key={objectUrl}
                className="player-video"
                src={objectUrl}
                controls
                autoPlay
                playsInline
              />
            ) : (
              <div className="player-audio-wrap">
                {item.thumbnail ? (
                  <img
                    className="player-art"
                    src={item.thumbnail}
                    alt=""
                  />
                ) : (
                  <div className="player-art player-art-fallback" aria-hidden>
                    {item.format.toUpperCase()}
                  </div>
                )}
                <audio
                  key={objectUrl}
                  className="player-audio"
                  src={objectUrl}
                  controls
                  autoPlay
                />
              </div>
            )
          ) : null}
        </div>
      </div>
    </div>
  );
}
