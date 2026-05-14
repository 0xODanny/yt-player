const STORAGE_KEY = "yt-local-tool:last-stream-tap-kind";

export type StreamTapKind = "audio" | "video";

export function getStreamTapKind(): StreamTapKind {
  if (typeof window === "undefined") {
    return "audio";
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "video" || raw === "audio") {
      return raw;
    }
  } catch {
    // ignore
  }
  return "audio";
}

export function setStreamTapKind(kind: StreamTapKind): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, kind);
  } catch {
    // ignore
  }
}
