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
    return normalizeManifest(parsed);
  } catch {
    // Manifest doesn't exist yet OR is unreadable. Fall back to localStorage
    // backup if we have one (covers the case where OPFS was just evicted
    // but localStorage survived).
    const backup = readManifestBackup();
    if (backup) {
      return normalizeManifest({
        ...backup,
        items: backup.items.map((item) => ({ ...item, missing: true })),
      });
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

  return {
    version: typeof raw.version === "number" ? raw.version : MANIFEST_VERSION,
    folders,
    items: Array.isArray(raw.items) ? raw.items : [],
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
  return URL.createObjectURL(blob);
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

export async function requestPersistentStorage(): Promise<boolean> {
  if (
    typeof navigator === "undefined" ||
    !navigator.storage ||
    typeof navigator.storage.persist !== "function"
  ) {
    return false;
  }
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
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
