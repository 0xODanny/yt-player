"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  DEFAULT_FOLDER_ID,
  createFolder,
  exportManifest,
  formatDurationShort,
  formatFileSize,
  getItemBlob,
  getStorageEstimate,
  importManifest,
  isLibrarySupported,
  loadManifest,
  type Manifest,
  type ManifestItem,
  moveItem,
  removeFolder,
  removeItem,
  renameFolder,
  renameItem,
  type StorageEstimate,
} from "@/lib/library";
import { formatLibraryAddedShort } from "@/lib/formatMediaMeta";
import { shareBlobNative } from "@/lib/nativeShare";
import {
  canonicalUrlForCurrentPage,
  CANONICAL_ORIGIN,
  detectOriginStatus,
  type OriginStatus,
} from "@/lib/origin";
import { isAndroidNative, isNative } from "@/lib/platform";
import { isStandaloneDisplayMode } from "@/lib/pwaInstall";
import { usePlayback } from "@/lib/playback";
import { useSettings } from "@/lib/settings";

/** Local date/time for export filenames (dd-mm-yyyy-hh-mm). */
function pepinhoLibraryExportFilename(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `pepinho-player-${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}-${p(d.getHours())}-${p(d.getMinutes())}.json`;
}

type LibraryViewProps = {
  reloadKey: number;
};

type LibrarySortMode = "added_desc" | "added_asc" | "duration_desc" | "duration_asc";

const LIBRARY_SORT_KEY = "yt-local-tool:library-sort-mode";

const LIBRARY_SORT_OPTIONS: Array<{ value: LibrarySortMode; label: string }> = [
  { value: "added_desc", label: "Newest added" },
  { value: "added_asc", label: "Oldest added" },
  { value: "duration_desc", label: "Longest" },
  { value: "duration_asc", label: "Shortest" },
];

function loadLibrarySortMode(): LibrarySortMode {
  if (typeof window === "undefined") {
    return "added_desc";
  }
  try {
    const raw = window.localStorage.getItem(LIBRARY_SORT_KEY);
    if (raw && LIBRARY_SORT_OPTIONS.some((o) => o.value === raw)) {
      return raw as LibrarySortMode;
    }
  } catch {
    // ignore
  }
  return "added_desc";
}

function persistLibrarySortMode(mode: LibrarySortMode) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(LIBRARY_SORT_KEY, mode);
  } catch {
    // ignore
  }
}

export function LibraryView({ reloadKey }: LibraryViewProps) {
  const { settings } = useSettings();
  const { playLibrary, stop, getActive, setLibraryEndedHandler } = usePlayback();
  const [supported] = useState(() => isLibrarySupported());
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [activeFolderId, setActiveFolderId] = useState<string>(DEFAULT_FOLDER_ID);
  const [storage, setStorage] = useState<StorageEstimate | null>(null);
  /** Per-folder playback: normal, loop entire folder order, or repeat current track. */
  const [folderPlayMode, setFolderPlayMode] = useState<
    "off" | "loop_folder" | "repeat_one"
  >("off");
  const [librarySortMode, setLibrarySortMode] = useState<LibrarySortMode>(() =>
    typeof window === "undefined" ? "added_desc" : loadLibrarySortMode(),
  );
  const [movingItem, setMovingItem] = useState<ManifestItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  // Origin-mismatch detection is window-dependent and must run after
  // hydration so React doesn't see a server-vs-client mismatch on the
  // banner element. Default to "canonical" until the effect fires.
  const [originStatus, setOriginStatus] = useState<OriginStatus>({
    kind: "canonical",
  });
  useEffect(() => {
    setOriginStatus(detectOriginStatus());
  }, []);

  const [standalonePwa, setStandalonePwa] = useState(false);
  useEffect(() => {
    setStandalonePwa(isStandaloneDisplayMode());
  }, []);

  const refresh = useCallback(async () => {
    if (!supported) {
      return;
    }
    const [next, est] = await Promise.all([loadManifest(), getStorageEstimate()]);
    setManifest(next);
    setStorage(est);
  }, [supported]);

  useEffect(() => {
    void refresh();
  }, [refresh, reloadKey]);

  useEffect(() => {
    persistLibrarySortMode(librarySortMode);
  }, [librarySortMode]);

  const folders = manifest?.folders ?? [];
  const items = useMemo(() => {
    if (!manifest) {
      return [];
    }
    const filtered = manifest.items.filter((item) => item.folderId === activeFolderId);
    const durationKey = (it: ManifestItem) =>
      typeof it.duration === "number" && it.duration > 0 ? it.duration : 0;
    const sorted = [...filtered];
    switch (librarySortMode) {
      case "added_desc":
        sorted.sort((a, b) => b.createdAt - a.createdAt);
        break;
      case "added_asc":
        sorted.sort((a, b) => a.createdAt - b.createdAt);
        break;
      case "duration_desc":
        sorted.sort(
          (a, b) =>
            durationKey(b) - durationKey(a) || b.createdAt - a.createdAt,
        );
        break;
      case "duration_asc":
        sorted.sort((a, b) => {
          const da = durationKey(a);
          const db = durationKey(b);
          if (da === 0 && db === 0) {
            return b.createdAt - a.createdAt;
          }
          if (da === 0) {
            return 1;
          }
          if (db === 0) {
            return -1;
          }
          return da - db || b.createdAt - a.createdAt;
        });
        break;
      default:
        break;
    }
    return sorted;
  }, [manifest, activeFolderId, librarySortMode]);

  useEffect(() => {
    setFolderPlayMode("off");
  }, [activeFolderId]);

  const repeatOneForPlayer = useMemo(
    () =>
      folderPlayMode === "repeat_one" ||
      (folderPlayMode === "loop_folder" && items.length === 1),
    [folderPlayMode, items.length],
  );

  const itemsRef = useRef(items);
  const folderPlayModeRef = useRef(folderPlayMode);
  itemsRef.current = items;
  folderPlayModeRef.current = folderPlayMode;

  useEffect(() => {
    setLibraryEndedHandler(() => {
      const mode = folderPlayModeRef.current;
      const list = itemsRef.current;
      if (mode !== "loop_folder" || list.length <= 1) {
        return;
      }
      const active = getActive();
      if (!active || active.kind !== "library") {
        return;
      }
      const idx = list.findIndex((i) => i.id === active.item.id);
      if (idx < 0) {
        return;
      }
      const next = list[(idx + 1) % list.length];
      if (!next) {
        return;
      }
      playLibrary({ item: next, repeatOne: false });
    });
    return () => setLibraryEndedHandler(null);
  }, [setLibraryEndedHandler, getActive, playLibrary]);

  const handleCreateFolder = useCallback(async () => {
    const name = window.prompt("Folder name");
    if (!name) {
      return;
    }
    setBusy(true);
    try {
      const folder = await createFolder(name);
      await refresh();
      setActiveFolderId(folder.id);
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const handleRenameFolder = useCallback(
    async (folderId: string, currentName: string) => {
      if (folderId === DEFAULT_FOLDER_ID) {
        return;
      }
      const next = window.prompt("Rename folder", currentName);
      if (!next) {
        return;
      }
      setBusy(true);
      try {
        await renameFolder(folderId, next);
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const handleDeleteFolder = useCallback(
    async (folderId: string) => {
      if (folderId === DEFAULT_FOLDER_ID) {
        return;
      }
      if (settings.confirmDelete) {
        const ok = window.confirm(
          "Delete this folder? Files inside will be moved to Default.",
        );
        if (!ok) {
          return;
        }
      }
      setBusy(true);
      try {
        await removeFolder(folderId);
        setActiveFolderId(DEFAULT_FOLDER_ID);
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh, settings.confirmDelete],
  );

  const handleMove = useCallback(
    (item: ManifestItem) => {
      if (folders.length <= 1) {
        window.alert("Create another folder first.");
        return;
      }
      setMovingItem(item);
    },
    [folders.length],
  );

  const performMove = useCallback(
    async (folderId: string) => {
      if (!movingItem) {
        return;
      }
      setBusy(true);
      try {
        await moveItem(movingItem.id, folderId);
        setMovingItem(null);
        setActiveFolderId(folderId);
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [movingItem, refresh],
  );

  const handleRename = useCallback(
    async (item: ManifestItem) => {
      const next = window.prompt("Rename item", item.title);
      if (!next) {
        return;
      }
      setBusy(true);
      try {
        await renameItem(item.id, next);
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const handleDeleteItem = useCallback(
    async (item: ManifestItem) => {
      if (settings.confirmDelete) {
        const ok = window.confirm(`Delete "${item.title}" from your library?`);
        if (!ok) {
          return;
        }
      }
      setBusy(true);
      try {
        await removeItem(item.id);
        const active = getActive();
        if (active?.kind === "library" && active.item.id === item.id) {
          stop();
        }
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh, settings.confirmDelete, getActive, stop],
  );

  const handleExportToDevice = useCallback(async (item: ManifestItem) => {
    const blob = await getItemBlob(item);
    if (!blob) {
      window.alert("This item is missing from the library and can't be exported.");
      return;
    }
    const safeName = item.title.replace(/[^\w.\- ]+/g, "_") || item.id;
    const filename = `${safeName}.${item.format}`;

    // Android Capacitor wrapper: skip the browser <a download> trick
    // (Android WebView's download manager is flaky for blob: URLs) and
    // stage the bytes to native Documents/ then pop the system Share
    // sheet. User picks "Save to Files" / "Downloads" / "Photos" /
    // whatever they want.
    if (isAndroidNative()) {
      try {
        await shareBlobNative(blob, {
          filename,
          mime: item.format === "mp3" ? "audio/mp4" : "video/mp4",
          dialogTitle: "Save to device",
        });
      } catch (error) {
        console.error("[library] native share failed", error);
        window.alert(
          "Couldn't open the system share sheet. The file is still in your library.",
        );
      }
      return;
    }

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }, []);

  const handleExportManifest = useCallback(async () => {
    const text = await exportManifest();
    const blob = new Blob([text], { type: "application/json" });
    const filename = pepinhoLibraryExportFilename();

    // Android WebView often ignores synthetic <a download> clicks for
    // blob: URLs — same reason as handleExportToDevice uses the share sheet.
    if (isAndroidNative()) {
      try {
        await shareBlobNative(blob, {
          filename,
          mime: "application/json",
          dialogTitle: "Export library",
        });
      } catch (error) {
        console.error("[library] manifest native share failed", error);
        window.alert(
          "Couldn't open the share sheet to export the manifest. Try again, or use Export on each track if needed.",
        );
      }
      return;
    }

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }, []);

  const handleImportClick = useCallback(() => {
    importInputRef.current?.click();
  }, []);

  const handleImportChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) {
        return;
      }
      setImportError(null);
      setBusy(true);
      try {
        const text = await file.text();
        await importManifest(text);
        await refresh();
      } catch {
        setImportError("That file doesn't look like a valid manifest.");
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  if (!supported) {
    return (
      <section className="panel">
        <div className="section-heading">
          <h2>Library</h2>
        </div>
        <p className="muted-text">
          This browser can&apos;t store files for offline playback. Try the
          latest Safari, Chrome, Edge, or Samsung Internet.
        </p>
      </section>
    );
  }

  const totalUsed = storage ? formatFileSize(storage.used) : "0 B";
  const totalQuota = storage && storage.quota > 0 ? formatFileSize(storage.quota) : null;
  const usedPercent =
    storage && storage.quota > 0
      ? Math.min(100, Math.round((storage.used / storage.quota) * 100))
      : null;

  return (
    <>
      <section className="panel library-panel">
        <div className="section-heading">
          <h2>Library</h2>
          <span className="job-id">
            {totalQuota
              ? `${totalUsed} of ${totalQuota}`
              : totalUsed}
          </span>
        </div>

        {originStatus.kind === "mismatch" ? (
          <div className="origin-warning" role="alert">
            <p>
              You&apos;re on <code>{originStatus.currentHost}</code>, but
              the canonical Pepinho Player address is{" "}
              <code>pepinho.lol</code> (no <code>www.</code>). Each host
              has its own private library — files saved on one
              <strong> can&apos;t </strong>be seen from the other.
            </p>
            <p className="origin-warning-actions">
              <a
                href={canonicalUrlForCurrentPage()}
                rel="noopener"
                className="origin-warning-cta"
              >
                Switch to {CANONICAL_ORIGIN.replace(/^https?:\/\//, "")}
              </a>
            </p>
            <p className="origin-warning-hint">
              If your old library was on this host, use{" "}
              <strong>Export library</strong> below to back it up first,
              then reinstall on the canonical host and{" "}
              <strong>Import</strong>.
            </p>
          </div>
        ) : null}

        {usedPercent !== null ? (
          <div className="storage-meter" aria-hidden>
            <div
              className="storage-meter-fill"
              style={{ width: `${Math.max(2, usedPercent)}%` }}
            />
          </div>
        ) : null}

        {storage && !storage.persisted && !isNative() && !standalonePwa ? (
          <p className="storage-warning" role="status">
            <strong>Using Pepinho in a browser tab?</strong> Your library may be
            cleared if the browser reclaims space. For the best experience: on{" "}
            <strong>iPhone (Safari)</strong>, tap Share, then{" "}
            <strong>Add to Home Screen</strong>, and open the app from that icon.
            On <strong>Android (Chrome)</strong>, open the menu (⋮) and choose{" "}
            <strong>Install app</strong> or <strong>Add to Home screen</strong>.
            This message does not appear in the installed app or the Android APK.
          </p>
        ) : null}

        <div className="folder-bar">
          <div className="folder-list" role="tablist" aria-label="Library folders">
            {folders.map((folder) => {
              const itemCount =
                manifest?.items.filter((entry) => entry.folderId === folder.id).length ?? 0;
              const isActive = folder.id === activeFolderId;
              return (
                <button
                  key={folder.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  className={`folder-chip${isActive ? " active" : ""}`}
                  onClick={() => setActiveFolderId(folder.id)}
                  onDoubleClick={() => void handleRenameFolder(folder.id, folder.name)}
                  title={
                    folder.id === DEFAULT_FOLDER_ID
                      ? folder.name
                      : "Click to open · double-click to rename"
                  }
                >
                  <span>{folder.name}</span>
                  <span className="folder-count">{itemCount}</span>
                </button>
              );
            })}
          </div>
          <div className="folder-actions">
            <button
              type="button"
              className="link-button"
              onClick={() => void handleCreateFolder()}
              disabled={busy}
            >
              + New folder
            </button>
            {activeFolderId !== DEFAULT_FOLDER_ID ? (
              <button
                type="button"
                className="link-button danger"
                onClick={() => void handleDeleteFolder(activeFolderId)}
                disabled={busy}
              >
                Delete folder
              </button>
            ) : null}
          </div>
          <div className="folder-playback" role="group" aria-label="Folder playback">
            <span className="folder-playback-label">Playback</span>
            <button
              type="button"
              className={`folder-chip folder-playback-chip${folderPlayMode === "off" ? " active" : ""}`}
              onClick={() => setFolderPlayMode("off")}
              title="Play one track at a time"
            >
              Normal
            </button>
            <button
              type="button"
              className={`folder-chip folder-playback-chip${
                folderPlayMode === "loop_folder" ? " active" : ""
              }`}
              onClick={() => setFolderPlayMode("loop_folder")}
              title="When a track ends, play the next in this folder (wraps)"
              aria-label="Loop folder: when a track ends, play the next in this folder"
            >
              <span aria-hidden>🔁</span> Folder
            </button>
            <button
              type="button"
              className={`folder-chip folder-playback-chip${
                folderPlayMode === "repeat_one" ? " active" : ""
              }`}
              onClick={() => setFolderPlayMode("repeat_one")}
              title="Repeat the current track"
              aria-label="Repeat one: play the same track again when it ends"
            >
              <span aria-hidden>🔂</span> One
            </button>
          </div>
        </div>

        <div className="library-sort-bar">
          <label className="library-sort-field">
            <span className="library-sort-label">Sort</span>
            <select
              className="library-sort-select"
              value={librarySortMode}
              onChange={(event) =>
                setLibrarySortMode(event.target.value as LibrarySortMode)
              }
              aria-label="Sort items in this folder"
            >
              {LIBRARY_SORT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {items.length === 0 ? (
          <div className="empty-card">
            <p>Nothing here yet.</p>
            <p className="muted-text">
              Save something from Search or Download and it&apos;ll show up here.
            </p>
          </div>
        ) : (
          <ul className="library-list">
            {items.map((item) => {
              const duration = formatDurationShort(item.duration);
              const addedShort = formatLibraryAddedShort(item.createdAt);
              return (
                <li key={item.id} className={`library-item${item.missing ? " missing" : ""}`}>
                  <button
                    type="button"
                    className="library-row"
                    onClick={() =>
                      playLibrary({ item, repeatOne: repeatOneForPlayer })
                    }
                    disabled={item.missing}
                    title={item.missing ? "File is missing — download again to play" : "Play"}
                  >
                    <div className="library-thumb-wrap">
                      {duration ? (
                        <span className="library-thumb-badge library-thumb-badge--duration">
                          {duration}
                        </span>
                      ) : null}
                      {addedShort ? (
                        <span className="library-thumb-badge library-thumb-badge--age">
                          {addedShort}
                        </span>
                      ) : null}
                      {item.thumbnail ? (
                        <img className="library-thumb" src={item.thumbnail} alt="" />
                      ) : (
                        <span className="library-thumb fallback" aria-hidden>
                          {item.format.toUpperCase()}
                        </span>
                      )}
                    </div>
                    <span className="library-meta">
                      <span className="library-title">{item.title}</span>
                      <span className="library-sub">
                        {item.format.toUpperCase()}
                        {duration ? ` · ${duration}` : ""}
                        {item.fileSize > 0 ? ` · ${formatFileSize(item.fileSize)}` : ""}
                        {item.missing ? " · missing" : ""}
                      </span>
                    </span>
                  </button>
                  <div className="library-actions">
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => void handleExportToDevice(item)}
                      disabled={busy || item.missing}
                      aria-label="Save to device"
                      title="Save to device"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => void handleMove(item)}
                      disabled={busy}
                      aria-label="Move to folder"
                      title="Move to folder"
                    >
                      ⇄
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => void handleRename(item)}
                      disabled={busy}
                      aria-label="Rename"
                      title="Rename"
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      className="icon-button danger"
                      onClick={() => void handleDeleteItem(item)}
                      disabled={busy}
                      aria-label="Delete"
                      title="Delete"
                    >
                      ×
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <div className="library-footer">
          <button type="button" className="link-button" onClick={() => void handleExportManifest()}>
            Export library
          </button>
          <button type="button" className="link-button" onClick={handleImportClick}>
            Import library
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => void handleImportChange(event)}
          />
        </div>
        {importError ? <p className="hint hint-warning">{importError}</p> : null}
      </section>

      {movingItem ? (
        <div
          className="player-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Move to folder"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setMovingItem(null);
            }
          }}
        >
          <div className="picker-dialog">
            <header className="player-header">
              <div className="player-titles">
                <h2>Move &ldquo;{movingItem.title}&rdquo;</h2>
                <p className="player-sub">Choose a destination folder</p>
              </div>
              <button
                type="button"
                className="player-close"
                aria-label="Close"
                onClick={() => setMovingItem(null)}
              >
                ×
              </button>
            </header>

            <ul className="folder-picker-list">
              {folders
                .filter((folder) => folder.id !== movingItem.folderId)
                .map((folder) => {
                  const itemCount =
                    manifest?.items.filter((entry) => entry.folderId === folder.id).length ?? 0;
                  return (
                    <li key={folder.id}>
                      <button
                        type="button"
                        className="folder-picker-row"
                        onClick={() => void performMove(folder.id)}
                        disabled={busy}
                      >
                        <span className="folder-picker-name">{folder.name}</span>
                        <span className="folder-count">{itemCount}</span>
                      </button>
                    </li>
                  );
                })}
            </ul>
          </div>
        </div>
      ) : null}
    </>
  );
}
