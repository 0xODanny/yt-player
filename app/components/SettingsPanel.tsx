"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isAndroidNative } from "@/lib/platform";
import {
  RELEASE_NOTES,
  getDisplayedReleaseVersion,
} from "@/lib/releaseInfo";
import {
  SETTING_DEFINITIONS,
  filterSettingDefinitionsForPlatform,
  type SettingDefinition,
  type Settings,
  useSettings,
} from "@/lib/settings";

type SettingsPanelProps = {
  open: boolean;
  onClose: () => void;
};

export function SettingsPanel({ open, onClose }: SettingsPanelProps) {
  const { settings, update, reset } = useSettings();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);

  const buildSha =
    typeof process !== "undefined"
      ? (process.env.NEXT_PUBLIC_BUILD_GIT_SHA ?? "").trim()
      : "";

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

  // Resolve the platform once on mount so SSR renders the most
  // restrictive option set (no Android-only entries) and the client
  // adds them in after hydration. Avoids the markup mismatch React
  // warns about when isAndroidNative() flips between server and
  // client without an effect boundary.
  const [androidNative, setAndroidNative] = useState(false);
  useEffect(() => {
    setAndroidNative(isAndroidNative());
  }, []);

  // Group definitions by section so adding a new section is a one-line change.
  const grouped = useMemo(() => {
    const filtered = filterSettingDefinitionsForPlatform(SETTING_DEFINITIONS, {
      androidNative,
    });
    const map = new Map<string, SettingDefinition[]>();
    for (const def of filtered) {
      const list = map.get(def.section) ?? [];
      list.push(def);
      map.set(def.section, list);
    }
    return Array.from(map.entries());
  }, [androidNative]);

  const checkForUpdates = useCallback(async () => {
    setUpdateBusy(true);
    setUpdateMessage(null);
    try {
      const response = await fetch(
        "https://api.github.com/repos/0xODanny/yt-player/commits/main",
        { headers: { Accept: "application/vnd.github+json" } },
      );
      if (!response.ok) {
        setUpdateMessage("Couldn’t check right now. Try again later.");
        return;
      }
      const data = (await response.json()) as { sha?: string };
      const remote = (data.sha ?? "").trim();
      if (!remote) {
        setUpdateMessage("Unexpected response while checking.");
        return;
      }
      if (!buildSha) {
        setUpdateMessage(
          "This copy doesn’t include a build stamp (normal when running from source).",
        );
        return;
      }
      if (remote === buildSha) {
        setUpdateMessage("You’re on the latest public build.");
        return;
      }
      const a = remote.slice(0, 7).toLowerCase();
      const b = buildSha.slice(0, 7).toLowerCase();
      if (a === b) {
        setUpdateMessage("You’re on the latest public build.");
        return;
      }
      setUpdateMessage(
        "A newer public build exists. Refresh this site or download the latest APK from GitHub Actions.",
      );
    } catch {
      setUpdateMessage("Network error — check your connection.");
    } finally {
      setUpdateBusy(false);
    }
  }, [buildSha]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="player-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onClick={(event) => {
        if (event.target === dialogRef.current) {
          onClose();
        }
      }}
    >
      <div className="picker-dialog settings-dialog" ref={dialogRef}>
        <header className="player-header">
          <div className="player-titles">
            <h2>Settings</h2>
            <p className="player-sub">
              Preferences are stored on this device only.
            </p>
          </div>
          <button
            type="button"
            className="player-close"
            aria-label="Close settings"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="settings-body">
          {grouped.map(([section, defs]) => (
            <section key={section} className="settings-section">
              <h3 className="settings-section-title">{section}</h3>
              <ul className="settings-list">
                {defs.map((def) => (
                  <li key={def.key} className="settings-row">
                    <div className="settings-text">
                      <span className="settings-label">{def.label}</span>
                      <span className="settings-description">{def.description}</span>
                    </div>
                    {def.type === "select" ? (
                      <select
                        className="settings-select"
                        aria-label={def.label}
                        value={String(settings[def.key])}
                        onChange={(event) =>
                          update(
                            def.key,
                            event.target.value as Settings[typeof def.key],
                          )
                        }
                      >
                        {def.options.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      (() => {
                        const enabled = Boolean(settings[def.key]);
                        return (
                          <button
                            type="button"
                            role="switch"
                            aria-checked={enabled}
                            aria-label={def.label}
                            className={`toggle${enabled ? " on" : ""}`}
                            onClick={() => update(def.key, !enabled as never)}
                          >
                            <span className="toggle-thumb" />
                          </button>
                        );
                      })()
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <section className="settings-section settings-about">
            <h3 className="settings-section-title">About</h3>
            <p className="about-version-line">
              <strong>Pepinho Player</strong> · release{" "}
              <span className="about-version-number">{getDisplayedReleaseVersion()}</span>
            </p>
            {buildSha ? (
              <p className="about-build-line muted-text">
                Build reference:{" "}
                <code className="about-build-sha">{buildSha.slice(0, 7)}</code>
                {buildSha.length > 7 ? "…" : null}
              </p>
            ) : (
              <p className="about-build-line muted-text">
                Local build — no public build reference embedded.
              </p>
            )}
            <div className="about-updates-row">
              <button
                type="button"
                className="link-button"
                disabled={updateBusy}
                onClick={() => void checkForUpdates()}
              >
                {updateBusy ? "Checking…" : "Check for updates"}
              </button>
              {updateMessage ? (
                <p className="about-update-message">{updateMessage}</p>
              ) : null}
            </div>
            <h4 className="about-whats-new">What&apos;s new</h4>
            <div className="about-scroll" tabIndex={0}>
              <ul className="about-notes-list">
                {RELEASE_NOTES.map((entry) => (
                  <li key={entry.version} className="about-release-block">
                    <p className="about-release-title">
                      <strong>{entry.version}</strong> — {entry.title}
                    </p>
                    <ul className="about-release-items">
                      {entry.items.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        </div>

        <footer className="settings-footer">
          <button
            type="button"
            className="link-button"
            onClick={() => {
              if (window.confirm("Reset all settings to defaults?")) {
                reset();
              }
            }}
          >
            Reset to defaults
          </button>
        </footer>
      </div>
    </div>
  );
}
