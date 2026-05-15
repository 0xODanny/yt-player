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

import { isIpRoyalHeavyDownloadDisabledInUi } from "./ipRoyalUsage";

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

export type AppTheme = "pepinho" | "smoke" | "paper";

export type SearchPreset =
  | "mp3"
  | "video-144p"
  | "video-240p"
  | "video-360p"
  | "video-720p"
  | "video-1080p"
  | "stream-audio"
  | "stream-video"
  // direct-* presets only function inside the native Android Capacitor
  // wrapper. On any other platform the SETTING_DEFINITIONS filter
  // hides them from the dropdown and the SearchView tap handler falls
  // back to the streaming path with a toast. See lib/platform.ts +
  // lib/nativeDownload.ts for the why.
  | "direct-audio"
  | "direct-video";

export type SkipSecondsOption = 5 | 10 | 15 | 30;

export type Settings = {
  theme: AppTheme;
  pipAuto: boolean;
  audioOnlyDefault: boolean;
  autoSaveLibrary: boolean;
  confirmDelete: boolean;
  searchPreset: SearchPreset;
  /** Skip back / forward buttons and headset double-tap step size. */
  skipSeconds: SkipSecondsOption;
  /** Default speed when a track starts (user can change per session in the player). */
  preferredPlaybackRate: number;
};

export const DEFAULT_SETTINGS: Settings = {
  theme: "pepinho",
  pipAuto: true,
  audioOnlyDefault: false,
  autoSaveLibrary: true,
  confirmDelete: true,
  searchPreset: "stream-audio",
  skipSeconds: 10,
  preferredPlaybackRate: 1,
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
  "direct-audio",
  "direct-video",
];

/**
 * Presets that only work inside the Android Capacitor app. The
 * settings UI hides them on every other platform (see
 * SETTING_DEFINITIONS construction below) and the SearchView render
 * path swaps them out for a stream fallback if a user somehow lands
 * on one (e.g. after migrating between devices).
 */
export const ANDROID_NATIVE_ONLY_PRESETS: SearchPreset[] = [
  "direct-audio",
  "direct-video",
];

export function isAndroidNativeOnlyPreset(preset: SearchPreset): boolean {
  return ANDROID_NATIVE_ONLY_PRESETS.includes(preset);
}

/**
 * Coerce a stored SearchPreset value into one we currently recognize.
 *
 * History: `direct-audio` / `direct-video` were retired in commit
 * 77339ed because the cross-platform PWA implementation broke on
 * YouTube's PO Token enforcement (no HLS available from yt-dlp,
 * googlevideo blocks the worker's ASN, browser fetch hits CORS on
 * itag 18). They're back in this commit but ONLY meaningful inside
 * the Android Capacitor wrapper — there, CapacitorHttp routes the
 * download through native code so neither CORS nor the ASN block
 * apply (the request leaves the phone over its cellular/WiFi IP).
 * The migration here is a no-op for known presets; the helper exists
 * so any future renames have a single chokepoint.
 */
function normalizeTheme(value: unknown): AppTheme {
  if (value === "smoke" || value === "paper" || value === "pepinho") {
    return value;
  }
  return DEFAULT_SETTINGS.theme;
}

function normalizeSearchPreset(value: unknown): SearchPreset {
  if (
    typeof value === "string" &&
    KNOWN_PRESETS.includes(value as SearchPreset)
  ) {
    const candidate = value as SearchPreset;
    if (isIpRoyalHeavyDownloadDisabledInUi(candidate)) {
      return "stream-audio";
    }
    return candidate;
  }
  return DEFAULT_SETTINGS.searchPreset;
}

const SKIP_SECONDS_VALUES: SkipSecondsOption[] = [5, 10, 15, 30];

function normalizeSkipSeconds(value: unknown): SkipSecondsOption {
  const n = Number(value);
  return SKIP_SECONDS_VALUES.includes(n as SkipSecondsOption)
    ? (n as SkipSecondsOption)
    : DEFAULT_SETTINGS.skipSeconds;
}

const PLAYBACK_RATE_VALUES = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;

function normalizePreferredPlaybackRate(value: unknown): number {
  const n = Number(value);
  return PLAYBACK_RATE_VALUES.includes(n as (typeof PLAYBACK_RATE_VALUES)[number])
    ? n
    : DEFAULT_SETTINGS.preferredPlaybackRate;
}

export type SettingDefinitionToggle = {
  type?: "toggle";
  key: keyof Settings;
  label: string;
  description: string;
  section: "Appearance" | "Playback" | "Library" | "Search";
};

export type SettingDefinitionSelect = {
  type: "select";
  key: keyof Settings;
  label: string;
  description: string;
  section: "Appearance" | "Playback" | "Library" | "Search";
  options: Array<{
    value: string;
    label: string;
    /**
     * When true, the option is only rendered if the runtime is the
     * native Android Capacitor wrapper. Settings UI consumers should
     * call filterSettingDefinitionsForPlatform() before rendering.
     */
    androidNativeOnly?: boolean;
  }>;
};

export type SettingDefinition = SettingDefinitionToggle | SettingDefinitionSelect;

export const SETTING_DEFINITIONS: SettingDefinition[] = [
  {
    type: "select",
    key: "theme",
    label: "Color theme",
    description:
      "OG Pepinho is the classic sage palette. Smoke is a calm dark slate. Paper is a soft light mode with dark text.",
    section: "Appearance",
    options: [
      { value: "pepinho", label: "OG Pepinho (sage)" },
      { value: "smoke", label: "Smoke (cool dark)" },
      { value: "paper", label: "Paper (soft light)" },
    ],
  },
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
    key: "skipSeconds",
    label: "Skip back / forward step",
    description:
      "How many seconds the ± skip buttons and headset seek actions jump each tap.",
    section: "Playback",
    options: [
      { value: "5", label: "5 seconds" },
      { value: "10", label: "10 seconds" },
      { value: "15", label: "15 seconds" },
      { value: "30", label: "30 seconds" },
    ],
  },
  {
    type: "select",
    key: "preferredPlaybackRate",
    label: "Default playback speed",
    description:
      "Starting speed for new playback. You can still change speed from the player toolbar for the current track.",
    section: "Playback",
    options: [
      { value: "0.75", label: "0.75×" },
      { value: "1", label: "1× (normal)" },
      { value: "1.25", label: "1.25×" },
      { value: "1.5", label: "1.5×" },
      { value: "1.75", label: "1.75×" },
      { value: "2", label: "2×" },
    ],
  },
  {
    type: "select",
    key: "searchPreset",
    label: "When you tap a result (advanced)",
    description:
      "On Search, a row tap always streams (audio or video — use the Audio/Video chips). This list is for compatibility and the ⋯ menu. Server-side saves that pull the full file through our worker (MP3 / fixed video) are paused in this build to protect paid proxy quota — set REACTIVATE_IPROYAL_HEAVY_WORKER_DOWNLOADS in lib/ipRoyalUsage.ts to bring them back.",
    section: "Search",
    options: [
      { value: "stream-audio", label: "Play audio" },
      { value: "stream-video", label: "Play video" },
      { value: "mp3", label: "Save as MP3" },
      { value: "video-144p", label: "Save as 144p video" },
      { value: "video-240p", label: "Save as 240p video" },
      { value: "video-360p", label: "Save as 360p video" },
      { value: "video-720p", label: "Save as 720p video" },
      { value: "video-1080p", label: "Save as 1080p video" },
      {
        value: "direct-audio",
        label: "Quick audio save (phone data)",
        androidNativeOnly: true,
      },
      {
        value: "direct-video",
        label: "Quick video save (phone data)",
        androidNativeOnly: true,
      },
    ],
  },
  {
    key: "autoSaveLibrary",
    label: "Auto-save downloads to library",
    description:
      "When a download finishes, store the file in your library so you can play it again without re-downloading.",
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

/**
 * Strip options that are flagged androidNativeOnly when the runtime
 * isn't the Android Capacitor wrapper. Callers should pass the
 * result of `isAndroidNative()` from lib/platform.ts; we don't import
 * it directly here to keep this module free of side-effects (and so
 * SSR can call it with a constant `false`).
 */
export function filterSettingDefinitionsForPlatform(
  definitions: SettingDefinition[],
  context: { androidNative: boolean },
): SettingDefinition[] {
  return definitions.map((def) => {
    if (def.type !== "select") return def;
    if (context.androidNative) return def;
    return {
      ...def,
      options: def.options.filter((opt) => !opt.androidNativeOnly),
    };
  });
}

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
    merged.theme = normalizeTheme(merged.theme);
    merged.searchPreset = normalizeSearchPreset(merged.searchPreset);
    merged.skipSeconds = normalizeSkipSeconds(merged.skipSeconds);
    merged.preferredPlaybackRate = normalizePreferredPlaybackRate(
      merged.preferredPlaybackRate,
    );
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

  useEffect(() => {
    if (!hydrated || typeof document === "undefined") {
      return;
    }
    const t = settings.theme;
    if (t === "pepinho") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", t);
    }
  }, [hydrated, settings.theme]);

  const update = useCallback(
    <K extends keyof Settings>(key: K, value: Settings[K]) => {
      setSettings((current) => {
        if (key === "skipSeconds") {
          return {
            ...current,
            skipSeconds: normalizeSkipSeconds(value),
          };
        }
        if (key === "preferredPlaybackRate") {
          return {
            ...current,
            preferredPlaybackRate: normalizePreferredPlaybackRate(value),
          };
        }
        return { ...current, [key]: value };
      });
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
