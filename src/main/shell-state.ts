import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";

export interface ShellState {
  width: number;
  height: number;
  maximized: boolean;
  drawerCollapsed: boolean;
  whatsappTheme: "whatsapp" | "system";
  notificationsEnabled: boolean;
  /** Allow WhatsApp Web to request microphone access. */
  microphoneEnabled: boolean;
  /** Allow WhatsApp Web to request camera access. */
  cameraEnabled: boolean;
  /** Wipe the WhatsApp session (cookies, local/indexed storage) on quit. */
  signOutOnQuit: boolean;
  /** Keep the custom palette even when the Omarchy theme changes. */
  colorsPinned: boolean;
  shortcuts: ShortcutPreferences;
}

export interface ShortcutPreferences {
  toggleDrawer: string;
  search: string;
  openArchived: string;
  scrollDown: string;
  scrollUp: string;
  focusComposer: string;
  cycleForward: string;
  cycleBackward: string;
  navigation: Record<"1" | "2" | "3" | "4" | "5" | "6" | "7" | "8", string>;
}

export const DEFAULT_SHELL_STATE: ShellState = {
  width: 1280,
  height: 800,
  maximized: false,
  drawerCollapsed: true,
  whatsappTheme: "whatsapp",
  notificationsEnabled: true,
  microphoneEnabled: true,
  cameraEnabled: true,
  signOutOnQuit: false,
  colorsPinned: false,
  shortcuts: {
    toggleDrawer: "Ctrl+L",
    search: "Ctrl+/",
    openArchived: "Ctrl+Shift+A",
    scrollDown: "Ctrl+J",
    scrollUp: "Ctrl+K",
    focusComposer: "Ctrl+I",
    cycleForward: "Ctrl+Shift+J",
    cycleBackward: "Ctrl+Shift+K",
    navigation: {
      "1": "Ctrl+1",
      "2": "Ctrl+2",
      "3": "Ctrl+3",
      "4": "Ctrl+4",
      "5": "Ctrl+5",
      "6": "Ctrl+6",
      "7": "Ctrl+7",
      "8": "Ctrl+8",
    },
  },
};

function defaultShellState(): ShellState {
  return {
    ...DEFAULT_SHELL_STATE,
    shortcuts: {
      ...DEFAULT_SHELL_STATE.shortcuts,
      navigation: { ...DEFAULT_SHELL_STATE.shortcuts.navigation },
    },
  };
}

const MIN_WIDTH = 720;
const MIN_HEIGHT = 520;
const MAX_DIMENSION = 10_000;

function statePath(): string {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(app.getPath("home"), ".config");
  return path.join(configHome, "prettyzap", "shell-state.json");
}

function validDimension(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= MAX_DIMENSION;
}

export function normalizeShellState(value: unknown): ShellState {
  if (!value || typeof value !== "object") return defaultShellState();
  const candidate = value as Partial<ShellState>;
  if (!validDimension(candidate.width, MIN_WIDTH) || !validDimension(candidate.height, MIN_HEIGHT)) {
    return defaultShellState();
  }
  return {
    width: candidate.width,
    height: candidate.height,
    maximized: candidate.maximized === true,
    drawerCollapsed: candidate.drawerCollapsed !== false,
    whatsappTheme: candidate.whatsappTheme === "system" ? "system" : "whatsapp",
    notificationsEnabled: candidate.notificationsEnabled !== false,
    microphoneEnabled: candidate.microphoneEnabled !== false,
    cameraEnabled: candidate.cameraEnabled !== false,
    signOutOnQuit: candidate.signOutOnQuit === true,
    colorsPinned: candidate.colorsPinned === true,
    shortcuts: normalizeShortcutPreferences(candidate.shortcuts),
  };
}

export function normalizeShortcutPreferences(value: unknown): ShortcutPreferences {
  const candidate = value && typeof value === "object" ? value as Partial<ShortcutPreferences> : {};
  const defaults = DEFAULT_SHELL_STATE.shortcuts;
  const valid = (key: Exclude<keyof ShortcutPreferences, "navigation">): string =>
    typeof candidate[key] === "string" && candidate[key].trim().length > 0
      ? candidate[key].trim()
      : defaults[key];

  return {
    toggleDrawer: valid("toggleDrawer"),
    search: valid("search"),
    openArchived: valid("openArchived"),
    scrollDown: valid("scrollDown"),
    scrollUp: valid("scrollUp"),
    focusComposer: valid("focusComposer"),
    cycleForward: valid("cycleForward"),
    cycleBackward: valid("cycleBackward"),
    navigation: {
      "1": typeof candidate.navigation?.["1"] === "string" && candidate.navigation["1"].trim() ? candidate.navigation["1"].trim() : defaults.navigation["1"],
      "2": typeof candidate.navigation?.["2"] === "string" && candidate.navigation["2"].trim() ? candidate.navigation["2"].trim() : defaults.navigation["2"],
      "3": typeof candidate.navigation?.["3"] === "string" && candidate.navigation["3"].trim() ? candidate.navigation["3"].trim() : defaults.navigation["3"],
      "4": typeof candidate.navigation?.["4"] === "string" && candidate.navigation["4"].trim() ? candidate.navigation["4"].trim() : defaults.navigation["4"],
      "5": typeof candidate.navigation?.["5"] === "string" && candidate.navigation["5"].trim() ? candidate.navigation["5"].trim() : defaults.navigation["5"],
      "6": typeof candidate.navigation?.["6"] === "string" && candidate.navigation["6"].trim() ? candidate.navigation["6"].trim() : defaults.navigation["6"],
      "7": typeof candidate.navigation?.["7"] === "string" && candidate.navigation["7"].trim() ? candidate.navigation["7"].trim() : defaults.navigation["7"],
      "8": typeof candidate.navigation?.["8"] === "string" && candidate.navigation["8"].trim() ? candidate.navigation["8"].trim() : defaults.navigation["8"],
    },
  };
}

export function loadShellState(): ShellState {
  try {
    return normalizeShellState(JSON.parse(fs.readFileSync(statePath(), "utf8")));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("Unable to load PrettyZap shell state", error);
    }
    return defaultShellState();
  }
}

export function saveShellState(state: ShellState): void {
  const file = statePath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${JSON.stringify(normalizeShellState(state), null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch (error: unknown) {
    console.warn("Unable to save PrettyZap shell state", error);
  }
}
