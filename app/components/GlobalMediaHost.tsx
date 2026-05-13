"use client";

import { MediaPlayer } from "./MediaPlayer";
import { usePlayback } from "@/lib/playback";

export function GlobalMediaHost() {
  const { active, layout, setLayout, stop, notifyLibraryPlaybackEnded } = usePlayback();

  if (!active) {
    return null;
  }

  return (
    <MediaPlayer
      item={active.kind === "library" ? active.item : null}
      stream={active.kind === "stream" ? active.stream : null}
      streamMeta={active.kind === "stream" ? active.streamMeta : undefined}
      layout={layout}
      repeatOne={active.kind === "library" ? active.repeatOne : false}
      onLibraryPlaybackEnded={
        active.kind === "library" ? notifyLibraryPlaybackEnded : undefined
      }
      onMinimize={() => setLayout("minimized")}
      onExpand={() => setLayout("expanded")}
      onClose={stop}
    />
  );
}
