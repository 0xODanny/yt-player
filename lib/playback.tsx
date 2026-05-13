"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { ManifestItem } from "@/lib/library";
import type { StreamSource } from "@/lib/stream";

export type LibraryPlaybackPayload = {
  item: ManifestItem;
  repeatOne: boolean;
};

export type StreamPlaybackPayload = {
  stream: StreamSource;
  streamMeta?: {
    title?: string;
    author?: string;
    thumbnail?: string;
  };
};

export type ActivePlayback =
  | ({ kind: "library" } & LibraryPlaybackPayload)
  | ({ kind: "stream" } & StreamPlaybackPayload);

export type PlaybackLayout = "expanded" | "minimized";

type PlaybackContextValue = {
  active: ActivePlayback | null;
  layout: PlaybackLayout;
  playLibrary: (payload: LibraryPlaybackPayload) => void;
  playStream: (payload: StreamPlaybackPayload) => void;
  setLayout: (layout: PlaybackLayout) => void;
  stop: () => void;
  /** Latest active playback (for library folder-advance without stale closures). */
  getActive: () => ActivePlayback | null;
  /** Register handler for natural end of library playback (folder loop). */
  setLibraryEndedHandler: (fn: (() => void) | null) => void;
  /** Called from MediaPlayer when a library track ends (loop-folder advance). */
  notifyLibraryPlaybackEnded: () => void;
};

const PlaybackContext = createContext<PlaybackContextValue | null>(null);

export function PlaybackProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<ActivePlayback | null>(null);
  const [layout, setLayout] = useState<PlaybackLayout>("expanded");
  const activeRef = useRef<ActivePlayback | null>(null);
  const libraryEndedHandlerRef = useRef<(() => void) | null>(null);

  activeRef.current = active;

  const getActive = useCallback(() => activeRef.current, []);

  const setLibraryEndedHandler = useCallback((fn: (() => void) | null) => {
    libraryEndedHandlerRef.current = fn;
  }, []);

  const playLibrary = useCallback((payload: LibraryPlaybackPayload) => {
    setActive({ kind: "library", ...payload });
    setLayout("expanded");
  }, []);

  const playStream = useCallback((payload: StreamPlaybackPayload) => {
    libraryEndedHandlerRef.current = null;
    setActive({ kind: "stream", ...payload });
    setLayout("expanded");
  }, []);

  const stop = useCallback(() => {
    setActive(null);
    setLayout("expanded");
    libraryEndedHandlerRef.current = null;
  }, []);

  const notifyLibraryPlaybackEnded = useCallback(() => {
    libraryEndedHandlerRef.current?.();
  }, []);

  const value = useMemo(
    () => ({
      active,
      layout,
      playLibrary,
      playStream,
      setLayout,
      stop,
      getActive,
      setLibraryEndedHandler,
      notifyLibraryPlaybackEnded,
    }),
    [
      active,
      layout,
      playLibrary,
      playStream,
      stop,
      getActive,
      setLibraryEndedHandler,
      notifyLibraryPlaybackEnded,
    ],
  );

  return <PlaybackContext.Provider value={value}>{children}</PlaybackContext.Provider>;
}

export function usePlayback(): PlaybackContextValue {
  const ctx = useContext(PlaybackContext);
  if (!ctx) {
    throw new Error("usePlayback must be used within PlaybackProvider");
  }
  return ctx;
}

/** Safe for optional UI (e.g. future embeds); returns null outside provider. */
export function usePlaybackOptional(): PlaybackContextValue | null {
  return useContext(PlaybackContext);
}
