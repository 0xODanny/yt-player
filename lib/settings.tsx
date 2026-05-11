"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * App-wide user settings.
 *
 * Each setting is persisted to localStorage under SETTINGS_STORAGE_KEY.
 * To add a new option:
 *   1. Add a typed field to `Settings` and a default in `DEFAULT_SETTINGS`.
 *   2. Add a row to the SETTING_DEFINITIONS array (drives the UI auto-render).
 *   3. Read the value from `useSettings()` wherever it's needed.
 * No other files need to change to render a new toggle.
 */

export type SearchPreset =
  | "mp3"
  | "video-144p"
  | "video-240p"
  | "video-360p"
  | "video-720p"
  | "video-1080p"
  | "stream-audio"
  | "stream-video";

export type Settings = {
  pipAuto: boolean;
  audioOnlyDefault: boolean;
  autoSaveLibrary: boolean;
  confirmDelete: boolean;
  searchPreset: SearchPreset;
};

export const DEFAULT_SETTINGS: Settings = {
  pipAuto: true,
  audioOnlyDefault: false,
  autoSaveLibrary: true,
  confirmDelete: true,
  searchPreset: "mp3",
};

const KNOWN_PRESETS: SearchPreset[] = [
  "mp3",
  "video-144p",
  "video-240p",
  "video-360p",
  "video-720p",
  "video-1080p",
  "stream-audio",
  "stream-video",
];

/**
 * Map retired SearchPreset values back into a current one so users
 * with a stale localStorage entry don't get stuck on an unrecognized
 * preset that no chip / option matches.
 *
 * History: `direct-audio` / `direct-video` were a short-lived
 * "save without using IPRoyal bandwidth" experiment that died on
 * YouTube's PO Token enforcement in 2026. yt-dlp via the
 * ios/tv/mweb/android player_clients returns only the legacy itag
 * 18 progressive URL for ~all videos now. Browser fetch() can't
 * pull itag 18 (no CORS), and the worker can't proxy it either
 * (googlevideo blocks DigitalOcean's ASN). The streaming path is
 * unaffected because <video src=...> uses opaque media load, which
 * doesn't go through CORS.
 */
function normalizeSearchPreset(value: unknown): SearchPreset {
  if (
    typeof value === "string" &&
    KNOWN_PRESETS.includes(value as SearchPreset)
  ) {
    return value as SearchPreset;
  }
  if (value === "direct-audio") return "mp3";
  if (value === "direct-video") return "video-360p";
  return DEFAULT_SETTINGS.searchPreset;
}

export type SettingDefinitionToggle = {
  type?: "toggle";
  key: keyof Settings;
  label: string;
  description: string;
  section: "Playback" | "Library" | "Search";
};

export type SettingDefinitionSelect = {
  type: "select";
  key: keyof Settings;
  label: string;
  description: string;
  section: "Playback" | "Library" | "Search";
  options: Array<{ value: string; label: string }>;
};

export type SettingDefinition = SettingDefinitionToggle | SettingDefinitionSelect;

export const SETTING_DEFINITIONS: SettingDefinition[] = [
  {
    key: "pipAuto",
    label: "Auto Picture-in-Picture",
    description:
      "When playing a video and you switch apps or lock the screen, the player pops out into a floating window so playback continues.",
    section: "Playback",
  },
  {
    key: "audioOnlyDefault",
    label: "Audio-only mode by default",
    description:
      "Open videos in audio-only mode so playback continues with the screen off and uses less battery. You can still switch to video inside the player.",
    section: "Playback",
  },
  {
    type: "select",
    key: "searchPreset",
    label: "Default action from search",
    description:
      "What happens when you tap a result. Stream plays the video directly (ad-free, your phone data). Download via worker uses yt-dlp through the IPRoyal residential proxy for full quality and saves to your library.",
    section: "Search",
    options: [
      { value: "stream-audio", label: "Stream audio (no save, ad-free)" },
      { value: "stream-video", label: "Stream video (no save, ad-free)" },
      { value: "mp3", label: "Download MP3 via worker (~5 MB)" },
      { value: "video-144p", label: "Download 144p via worker (~12 MB)" },
      { value: "video-240p", label: "Download 240p via worker (~25 MB)" },
      { value: "video-360p", label: "Download 360p via worker (~50 MB)" },
      { value: "video-720p", label: "Download 720p via worker (~80 MB)" },
      { value: "video-1080p", label: "Download 1080p via worker (~150 MB)" },
    ],
  },
  {
    key: "autoSaveLibrary",
    label: "Auto-save downloads to library",
    description:
      "When a download finishes, automatically store the file in the in-app library so you can play it back without re-downloading.",
    section: "Library",
  },
  {
    key: "confirmDelete",
    label: "Confirm before deleting",
    description:
      "Ask for confirmation when removing items or folders from the library.",
    section: "Library",
  },
];

const SETTINGS_STORAGE_KEY = "yt-local-tool:settings";

function loadSettings(): Settings {
  if (typeof window === "undefined") {
    return DEFAULT_SETTINGS;
  }
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_SETTINGS;
    }
    const parsed = JSON.parse(raw) as Partial<Settings>;
    // searchPreset may carry a retired value (e.g. "direct-audio") from
    // an older app version sitting in the user's localStorage. Migrate
    // it to a current preset so the UI stays consistent and the tap
    // handler doesn't fall through to its default branch.
    const merged: Settings = { ...DEFAULT_SETTINGS, ...parsed };
    merged.searchPreset = normalizeSearchPreset(merged.searchPreset);
    return merged;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function persistSettings(settings: Settings): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore quota errors
  }
}

type SettingsContextValue = {
  settings: Settings;
  update: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  reset: () => void;
};

const SettingsContext = createContext<SettingsContextValue>({
  settings: DEFAULT_SETTINGS,
  update: () => undefined,
  reset: () => undefined,
});

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [hydrated, setHydrated] = useState(false);

  // Hydrate from localStorage on the client; the initial state stays
  // DEFAULT_SETTINGS during SSR so the markup matches.
  useEffect(() => {
    setSettings(loadSettings());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) {
      return;
    }
    persistSettings(settings);
  }, [settings, hydrated]);

  const update = useCallback(
    <K extends keyof Settings>(key: K, value: Settings[K]) => {
      setSettings((current) => ({ ...current, [key]: value }));
    },
    [],
  );

  const reset = useCallback(() => {
    setSettings(DEFAULT_SETTINGS);
  }, []);

  const value = useMemo(
    () => ({ settings, update, reset }),
    [settings, update, reset],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  return useContext(SettingsContext);
}
