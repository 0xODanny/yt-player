/**
 * Library: in-PWA media storage backed by the Origin Private File System.
 *
 * Why OPFS:
 *   The File System Access API (which can write to user-chosen folders) is
 *   unsupported on iOS Safari. OPFS is the only sandboxed write API that
 *   works on iOS, Android, and desktop. Files live inside the PWA's
 *   sandbox; the user can't see them in iOS Files / Android file manager,
 *   but the PWA can list, play, move, and delete them freely.
 *
 * Resilience:
 *   The browser may evict OPFS data when storage is tight (more likely on
 *   iOS unless `navigator.storage.persist()` was granted). To survive that,
 *   we keep a manifest.json describing every saved item — title, source
 *   URL, format, duration, etc. The manifest is also mirrored into
 *   localStorage as a best-effort backup. If files are ever wiped, the
 *   user can re-import the manifest and re-trigger downloads from their
 *   original URLs.
 */

export const DEFAULT_FOLDER_ID = "default";
export const DEFAULT_FOLDER_NAME = "Default";
export const MANIFEST_FILENAME = "manifest.json";
export const FILES_DIRECTORY = "files";
export const MANIFEST_VERSION = 1;
export const MANIFEST_BACKUP_KEY = "yt-local-tool:library-manifest-backup";

export type ItemType = "audio" | "video";

export type ManifestFolder = {
  id: string;
  name: string;
  createdAt: number;
};

export type ManifestItem = {
  id: string;
  fileName: string;
  folderId: string;
  title: string;
  sourceUrl: string;
  format: "mp3" | "mp4";
  quality: string;
  type: ItemType;
  duration?: number | null;
  fileSize: number;
  thumbnail?: string;
  author?: string;
  createdAt: number;
  missing?: boolean;
};

export type Manifest = {
  version: number;
  folders: ManifestFolder[];
  items: ManifestItem[];
};

export type StorageEstimate = {
  used: number;
  quota: number;
  persisted: boolean;
};

function emptyManifest(): Manifest {
  return {
    version: MANIFEST_VERSION,
    folders: [
      {
        id: DEFAULT_FOLDER_ID,
        name: DEFAULT_FOLDER_NAME,
        createdAt: Date.now(),
      },
    ],
    items: [],
  };
}

export function isLibrarySupported(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  return Boolean(navigator.storage && typeof navigator.storage.getDirectory === "function");
}

async function getRoot(): Promise<FileSystemDirectoryHandle> {
  if (!isLibrarySupported()) {
    throw new Error("This browser can't store files for offline playback.");
  }
  return await navigator.storage.getDirectory();
}

async function getFilesDir(create = true): Promise<FileSystemDirectoryHandle> {
  const root = await getRoot();
  return await root.getDirectoryHandle(FILES_DIRECTORY, { create });
}

export async function loadManifest(): Promise<Manifest> {
  if (!isLibrarySupported()) {
    return emptyManifest();
  }

  try {
    const root = await getRoot();
    const handle = await root.getFileHandle(MANIFEST_FILENAME, { create: false });
    const file = await handle.getFile();
    const text = await file.text();
    const parsed = JSON.parse(text) as Manifest;
    const manifest = normalizeManifest(parsed);
    if (manifestMetadataRepairDirty(parsed, manifest)) {
      await saveManifest(manifest);
    }
    return manifest;
  } catch {
    // Manifest doesn't exist yet OR is unreadable. Fall back to localStorage
    // backup if we have one (covers the case where OPFS was just evicted
    // but localStorage survived).
    const backup = readManifestBackup();
    if (backup) {
      const merged: Manifest = {
        ...backup,
        items: backup.items.map((item) => ({ ...item, missing: true })),
      };
      const manifest = normalizeManifest(merged);
      if (manifestMetadataRepairDirty(merged, manifest)) {
        await saveManifest(manifest);
      }
      return manifest;
    }
    return emptyManifest();
  }
}

function normalizeManifest(raw: Partial<Manifest> | null | undefined): Manifest {
  if (!raw) {
    return emptyManifest();
  }
  const folders = Array.isArray(raw.folders) && raw.folders.length > 0
    ? raw.folders
    : [
        {
          id: DEFAULT_FOLDER_ID,
          name: DEFAULT_FOLDER_NAME,
          createdAt: Date.now(),
        },
      ];

  // Always guarantee a Default folder exists.
  if (!folders.some((folder) => folder.id === DEFAULT_FOLDER_ID)) {
    folders.unshift({
      id: DEFAULT_FOLDER_ID,
      name: DEFAULT_FOLDER_NAME,
      createdAt: Date.now(),
    });
  }

  const rawItems = Array.isArray(raw.items) ? raw.items : [];
  const items = rawItems
    .map((entry) => sanitizeManifestItem(entry as Partial<ManifestItem>))
    .filter((entry): entry is ManifestItem => entry !== null);

  return {
    version: typeof raw.version === "number" ? raw.version : MANIFEST_VERSION,
    folders,
    items,
  };
}

export async function saveManifest(manifest: Manifest): Promise<void> {
  if (!isLibrarySupported()) {
    return;
  }

  try {
    const root = await getRoot();
    const handle = await root.getFileHandle(MANIFEST_FILENAME, { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(manifest, null, 2));
    await writable.close();
    writeManifestBackup(manifest);
  } catch (error) {
    console.warn("Failed to persist manifest", error);
  }
}

function readManifestBackup(): Manifest | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(MANIFEST_BACKUP_KEY);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as Manifest;
  } catch {
    return null;
  }
}

function writeManifestBackup(manifest: Manifest): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(MANIFEST_BACKUP_KEY, JSON.stringify(manifest));
  } catch {
    // localStorage is best-effort; ignore quota errors.
  }
}

function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

function inferTypeFromFormat(format: "mp3" | "mp4"): ItemType {
  return format === "mp3" ? "audio" : "video";
}

/**
 * Older manifests (or hand-edited JSON) sometimes had `type` out of sync
 * with `format` (e.g. mp3 labeled as video). That forced a <video> element
 * in the player; on Android WebView, video often pauses when the screen
 * locks even when the user expects audio. Repair type from format.
 */
function sanitizeManifestItem(
  raw: Partial<ManifestItem> & Record<string, unknown>,
): ManifestItem | null {
  if (typeof raw.id !== "string" || typeof raw.fileName !== "string") {
    return null;
  }
  const format: "mp3" | "mp4" =
    raw.format === "mp3" || raw.format === "mp4" ? raw.format : "mp4";
  let type: ItemType =
    raw.type === "audio" || raw.type === "video" ? raw.type : inferTypeFromFormat(format);
  if (format === "mp3" && type === "video") {
    type = "audio";
  }
  if (format === "mp4" && type !== "audio" && type !== "video") {
    type = "video";
  }

  return {
    id: raw.id,
    fileName: raw.fileName,
    folderId: typeof raw.folderId === "string" ? raw.folderId : DEFAULT_FOLDER_ID,
    title: typeof raw.title === "string" ? raw.title : "Untitled",
    sourceUrl: typeof raw.sourceUrl === "string" ? raw.sourceUrl : "",
    format,
    quality: typeof raw.quality === "string" ? raw.quality : "",
    type,
    duration: typeof raw.duration === "number" ? raw.duration : null,
    fileSize: typeof raw.fileSize === "number" ? raw.fileSize : 0,
    thumbnail: typeof raw.thumbnail === "string" ? raw.thumbnail : undefined,
    author: typeof raw.author === "string" ? raw.author : undefined,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
    missing: raw.missing === true ? true : undefined,
  };
}

/**
 * True when normalized items differ from what's on disk in ways we repair
 * (e.g. legacy type/format). Then we persist so the next app update and
 * export/import see the fixed metadata — in-memory-only repair wasn't
 * enough if the user never triggered another save.
 */
function manifestMetadataRepairDirty(
  parsed: Partial<Manifest>,
  normalized: Manifest,
): boolean {
  const rawItems = Array.isArray(parsed.items) ? parsed.items : [];
  const norm = normalized.items;
  if (rawItems.length !== norm.length) {
    return true;
  }
  const rawById = new Map(
    rawItems.map((entry) => {
      const r = entry as Partial<ManifestItem>;
      return [typeof r.id === "string" ? r.id : "", r] as const;
    }),
  );
  for (const n of norm) {
    const r = rawById.get(n.id);
    if (!r || typeof r.id !== "string") {
      return true;
    }
    const rFormat = r.format === "mp3" || r.format === "mp4" ? r.format : "";
    const rType = r.type === "audio" || r.type === "video" ? r.type : "";
    if (rFormat !== n.format || rType !== n.type) {
      return true;
    }
  }
  return false;
}

function fileExtForFormat(format: "mp3" | "mp4"): string {
  return format === "mp3" ? "mp3" : "mp4";
}

export type AddItemInput = {
  blob: Blob;
  title: string;
  sourceUrl: string;
  format: "mp3" | "mp4";
  quality: string;
  duration?: number | null;
  thumbnail?: string;
  author?: string;
  folderId?: string;
};

export async function addItem(input: AddItemInput): Promise<ManifestItem> {
  if (!isLibrarySupported()) {
    throw new Error("This browser can't store files for offline playback.");
  }

  // Triggered from a download-button click handler, so this is the
  // user-gesture context iOS Safari needs to actually grant
  // persistence. Don't await on the network path — fire-and-forget
  // so a slow persist() call doesn't delay the user-visible save.
  void requestPersistentStorage();

  const id = generateId();
  const fileName = `${id}.${fileExtForFormat(input.format)}`;

  const filesDir = await getFilesDir(true);
  const fileHandle = await filesDir.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(input.blob);
  await writable.close();

  const item: ManifestItem = {
    id,
    fileName,
    folderId: input.folderId || DEFAULT_FOLDER_ID,
    title: input.title || "Untitled",
    sourceUrl: input.sourceUrl,
    format: input.format,
    quality: input.quality,
    type: inferTypeFromFormat(input.format),
    duration: input.duration ?? null,
    fileSize: input.blob.size,
    thumbnail: input.thumbnail,
    author: input.author,
    createdAt: Date.now(),
  };

  const manifest = await loadManifest();
  manifest.items = [item, ...manifest.items];
  await saveManifest(manifest);

  return item;
}

export type StreamingAddItemInput = Omit<AddItemInput, "blob"> & {
  /**
   * Caller-provided async function that writes the file's bytes into
   * the freshly opened OPFS WritableStream and returns the byte count
   * actually written. The library code never touches the bytes — this
   * lets callers (e.g. nativeDownload.ts) pipe a fetch ReadableStream
   * directly to OPFS without materializing a 150 MB Blob in JS memory,
   * which was OOM-killing the WebView for video downloads on Android.
   */
  writeToStream: (writable: WritableStream<Uint8Array>) => Promise<{ size: number }>;
};

/**
 * Streaming counterpart of addItem(). The blob never exists in JS —
 * the caller is handed a WritableStream backed by the OPFS file and
 * is responsible for writing bytes into it (pipe / write-chunk).
 * Memory stays at a single chunk's worth (~1 MB) regardless of file
 * size, fixing the "downloads fail at 99 %" Android OOM crash for
 * large videos.
 */
export async function addItemFromStream(
  input: StreamingAddItemInput,
): Promise<ManifestItem> {
  if (!isLibrarySupported()) {
    throw new Error("This browser can't store files for offline playback.");
  }

  // See note in addItem(): we re-request persistence here from the
  // user-gesture click context so iOS Safari can actually grant it.
  void requestPersistentStorage();

  const id = generateId();
  const fileName = `${id}.${fileExtForFormat(input.format)}`;

  const filesDir = await getFilesDir(true);
  const fileHandle = await filesDir.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();

  let size: number;
  try {
    const result = await input.writeToStream(writable);
    size = result.size;
  } catch (error) {
    // Best-effort clean up the half-written OPFS file so we don't
    // leave bytes haunting the library after a failure.
    try {
      await writable.close();
    } catch {
      // ignore
    }
    try {
      await filesDir.removeEntry(fileName);
    } catch {
      // ignore
    }
    throw error;
  }

  const item: ManifestItem = {
    id,
    fileName,
    folderId: input.folderId || DEFAULT_FOLDER_ID,
    title: input.title || "Untitled",
    sourceUrl: input.sourceUrl,
    format: input.format,
    quality: input.quality,
    type: inferTypeFromFormat(input.format),
    duration: input.duration ?? null,
    fileSize: size,
    thumbnail: input.thumbnail,
    author: input.author,
    createdAt: Date.now(),
  };

  const manifest = await loadManifest();
  manifest.items = [item, ...manifest.items];
  await saveManifest(manifest);

  return item;
}

export async function removeItem(itemId: string): Promise<void> {
  const manifest = await loadManifest();
  const item = manifest.items.find((entry) => entry.id === itemId);
  if (!item) {
    return;
  }

  if (!item.missing) {
    try {
      const filesDir = await getFilesDir(true);
      await filesDir.removeEntry(item.fileName);
    } catch {
      // Best-effort: ignore missing files
    }
  }

  manifest.items = manifest.items.filter((entry) => entry.id !== itemId);
  await saveManifest(manifest);
}

export async function moveItem(itemId: string, folderId: string): Promise<void> {
  const manifest = await loadManifest();
  manifest.items = manifest.items.map((item) =>
    item.id === itemId ? { ...item, folderId } : item,
  );
  await saveManifest(manifest);
}

export async function renameItem(itemId: string, title: string): Promise<void> {
  const manifest = await loadManifest();
  manifest.items = manifest.items.map((item) =>
    item.id === itemId ? { ...item, title } : item,
  );
  await saveManifest(manifest);
}

export async function createFolder(name: string): Promise<ManifestFolder> {
  const manifest = await loadManifest();
  const folder: ManifestFolder = {
    id: generateId(),
    name: name.trim() || "New folder",
    createdAt: Date.now(),
  };
  manifest.folders = [...manifest.folders, folder];
  await saveManifest(manifest);
  return folder;
}

export async function renameFolder(folderId: string, name: string): Promise<void> {
  if (folderId === DEFAULT_FOLDER_ID) {
    return;
  }
  const manifest = await loadManifest();
  manifest.folders = manifest.folders.map((folder) =>
    folder.id === folderId ? { ...folder, name: name.trim() || folder.name } : folder,
  );
  await saveManifest(manifest);
}

export async function removeFolder(folderId: string): Promise<void> {
  if (folderId === DEFAULT_FOLDER_ID) {
    return;
  }
  const manifest = await loadManifest();
  // Move any items in the deleted folder back to Default rather than orphaning them.
  manifest.items = manifest.items.map((item) =>
    item.folderId === folderId ? { ...item, folderId: DEFAULT_FOLDER_ID } : item,
  );
  manifest.folders = manifest.folders.filter((folder) => folder.id !== folderId);
  await saveManifest(manifest);
}

export async function getItemBlob(item: ManifestItem): Promise<Blob | null> {
  if (item.missing) {
    return null;
  }
  try {
    const filesDir = await getFilesDir(false);
    const fileHandle = await filesDir.getFileHandle(item.fileName, { create: false });
    return await fileHandle.getFile();
  } catch {
    return null;
  }
}

export async function getItemObjectUrl(item: ManifestItem): Promise<string | null> {
  const blob = await getItemBlob(item);
  if (!blob) {
    return null;
  }
  // OPFS files often have an empty `type`; Android WebView may treat an
  // untyped blob URL like video and pause on screen lock. Pick a MIME from
  // manifest metadata when the file has no type.
  const fallbackMime =
    item.format === "mp3"
      ? "audio/mpeg"
      : item.type === "audio"
        ? "audio/mp4"
        : "video/mp4";
  const mime =
    typeof blob.type === "string" && blob.type.trim() !== "" ? blob.type : fallbackMime;
  const forUrl = blob.type === mime ? blob : blob.slice(0, blob.size, mime);
  return URL.createObjectURL(forUrl);
}

export async function exportManifest(): Promise<string> {
  const manifest = await loadManifest();
  return JSON.stringify(manifest, null, 2);
}

export async function importManifest(text: string): Promise<Manifest> {
  const parsed = JSON.parse(text) as Manifest;
  const normalized = normalizeManifest({
    ...parsed,
    items: (parsed.items ?? []).map((item) => ({ ...item, missing: true })),
  });
  await saveManifest(normalized);
  return normalized;
}

export async function getStorageEstimate(): Promise<StorageEstimate> {
  if (typeof navigator === "undefined" || !navigator.storage) {
    return { used: 0, quota: 0, persisted: false };
  }

  let used = 0;
  let quota = 0;
  if (typeof navigator.storage.estimate === "function") {
    const result = await navigator.storage.estimate();
    used = result.usage ?? 0;
    quota = result.quota ?? 0;
  }

  let persisted = false;
  if (typeof navigator.storage.persisted === "function") {
    try {
      persisted = await navigator.storage.persisted();
    } catch {
      persisted = false;
    }
  }

  return { used, quota, persisted };
}

let persistAttemptInFlight: Promise<boolean> | null = null;
let persistGranted = false;

export async function requestPersistentStorage(): Promise<boolean> {
  if (persistGranted) {
    return true;
  }
  if (persistAttemptInFlight) {
    return persistAttemptInFlight;
  }
  if (
    typeof navigator === "undefined" ||
    !navigator.storage ||
    typeof navigator.storage.persist !== "function"
  ) {
    return false;
  }
  persistAttemptInFlight = (async () => {
    try {
      // iOS Safari only grants persistent storage when the request
      // happens in response to a user gesture (tap/click handler).
      // Calling this from inside addItem() / addItemFromStream() —
      // both reached through a download-button onClick — guarantees
      // we're inside a gesture even on the second-and-later attempts.
      const granted = await navigator.storage.persist();
      persistGranted = granted;
      return granted;
    } catch {
      return false;
    } finally {
      // Allow a retry next time if the first attempt didn't grant
      // (e.g. mount-time call before any user interaction failed).
      if (!persistGranted) {
        persistAttemptInFlight = null;
      }
    }
  })();
  return persistAttemptInFlight;
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log10(bytes) / 3));
  const value = bytes / 1000 ** i;
  return `${value >= 100 || i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

export function formatDurationShort(duration: number | null | undefined): string | null {
  if (!duration || duration < 1) {
    return null;
  }
  const hours = Math.floor(duration / 3600);
  const minutes = Math.floor((duration % 3600) / 60);
  const seconds = Math.floor(duration % 60);

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
