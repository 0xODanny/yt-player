"use client";

import { useEffect, useState } from "react";

import { isAndroidNative } from "@/lib/platform";
import { isStandaloneDisplayMode } from "@/lib/pwaInstall";

type TipsPanelProps = {
  open: boolean;
  onClose: () => void;
};

export function TipsPanel({ open, onClose }: TipsPanelProps) {
  const [androidApp, setAndroidApp] = useState(false);
  const [standalone, setStandalone] = useState(false);

  useEffect(() => {
    setAndroidApp(isAndroidNative());
  }, []);

  useEffect(() => {
    setStandalone(isStandaloneDisplayMode());
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="player-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Tips"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="picker-dialog settings-dialog tips-dialog">
        <header className="player-header">
          <div className="player-titles">
            <h2>Tips</h2>
            <p className="player-sub">Get the best playback and battery behavior from Pepinho.</p>
          </div>
          <button type="button" className="player-close" aria-label="Close tips" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="settings-body tips-body">
          {androidApp ? (
            <section className="tips-section">
              <h3 className="tips-section-title">Android: don’t let the system sleep Pepinho</h3>
              <p className="tips-lead">
                If music stops when you leave the app or lock the screen, Samsung (and some other
                phones) may be <strong>auto-sleeping</strong> background apps.
              </p>
              <ol className="tips-steps">
                <li>Open <strong>Settings</strong>.</li>
                <li>
                  Go to <strong>Battery</strong> (sometimes under <strong>Device care</strong> →{" "}
                  <strong>Battery</strong>).
                </li>
                <li>
                  Open <strong>Background usage limits</strong> (or similar, e.g.{" "}
                  <strong>Sleeping apps</strong> / <strong>Never sleeping apps</strong>).
                </li>
                <li>
                  Enable <strong>Never auto sleeping apps</strong> or open the list of apps that
                  must never sleep.
                </li>
                <li>
                  Find <strong>Pepinho Player</strong> and add it / allow it so it isn’t frozen in
                  the background.
                </li>
              </ol>
              <p className="tips-note muted-text">
                Exact menu names vary by Android version and manufacturer — search settings for
                &quot;background&quot; or &quot;sleeping&quot; if you don’t see these paths.
              </p>
            </section>
          ) : null}

          <section className="tips-section">
            <h3 className="tips-section-title">Playback habits</h3>
            <ul className="tips-bullets">
              <li>
                Use the <strong>Home</strong> button to leave the app while audio plays.{" "}
                <strong>Swiping the app out of Recents</strong> often stops playback on Android —
                that’s normal for many apps using the in-app browser engine.
              </li>
              <li>
                For <strong>video</strong>, switch to <strong>Audio-only</strong> in the player so
                the screen can turn off without the system pausing a video surface.
              </li>
              <li>
                On Android video mode, prefer <strong>Audio-only</strong> or <strong>Home</strong>{" "}
                over swiping the app away — foldables can be a bit stricter about background
                playback.
              </li>
            </ul>
          </section>

          {!androidApp && !standalone ? (
            <section className="tips-section">
              <h3 className="tips-section-title">Browser &amp; library</h3>
              <ul className="tips-bullets">
                <li>
                  In Safari or Chrome, <strong>install / Add to Home Screen</strong> so your
                  library is less likely to be cleared when the browser reclaims space.
                </li>
              </ul>
            </section>
          ) : null}

          <section className="tips-section">
            <h3 className="tips-section-title">Updates &amp; settings</h3>
            <ul className="tips-bullets">
              <li>
                Open the <strong>gear</strong> → <strong>About</strong> →{" "}
                <strong>Check for updates</strong> to see if a newer build is on GitHub (APK users
                can grab the latest artifact there).
              </li>
              <li>
                <strong>Export library</strong> occasionally from the Library tab if you care
                about backups — stored files stay on this device / origin.
              </li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
