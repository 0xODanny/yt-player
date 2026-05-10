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

export type SearchPreset = "mp3" | "video-360p" | "video-720p" | "video-1080p";

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
    label: "Default download from search",
    description:
      "Quality used when you tap a result in the Search tab. MP3 audio is fastest and smallest — best for music in the gym.",
    section: "Search",
    options: [
      { value: "mp3", label: "MP3 audio (fastest, smallest)" },
      { value: "video-360p", label: "Video 360p (data saver)" },
      { value: "video-720p", label: "Video 720p" },
      { value: "video-1080p", label: "Video 1080p" },
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
    return { ...DEFAULT_SETTINGS, ...parsed };
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
