import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Palette handling shared by the theme feature and the settings IPC.
 *
 * PrettyZap consumes the same palette keys Omarchy's themes use
 * (mode + background/dark_background/darker_background/foreground/muted/
 * accent/selection/red/yellow/green/blue). On Omarchy the live theme file is
 * the source; everywhere else the user can keep a private copy at
 * ~/.config/prettyzap/colors.toml (same format) edited from the settings
 * window. Node-only (no electron import) so it stays unit-testable.
 */

export type PaletteMode = "dark" | "light";

export interface OmarchyPalette {
  mode: PaletteMode;
  background: string;
  darkBackground: string;
  darkerBackground: string;
  foreground: string;
  muted: string;
  accent: string;
  selection: string;
  red: string;
  yellow: string;
  green: string;
  blue: string;
}

/** IPC shape: mode plus one hex color per palette key. */
export interface PaletteColors {
  background: string;
  darkBackground: string;
  darkerBackground: string;
  foreground: string;
  muted: string;
  accent: string;
  selection: string;
  red: string;
  yellow: string;
  green: string;
  blue: string;
}

export interface PaletteSnapshot {
  kind: "omarchy" | "custom";
  /** Whether an Omarchy palette is the fallback behind a custom override. */
  omarchy: boolean;
  /** User pinned the custom palette (only meaningful on Omarchy). */
  pinned: boolean;
  mode: PaletteMode;
  colors: PaletteColors;
}

export type PaletteSourceKind = PaletteSnapshot["kind"];

export interface PaletteSource {
  kind: PaletteSourceKind;
  file: string;
  watchDir: string;
}

export interface PaletteSources {
  /** PrettyZap's own palette; a saved file always takes precedence. */
  custom: PaletteSource;
  /** The live Omarchy theme, when running under Omarchy. */
  omarchy: PaletteSource | undefined;
}

const PALETTE_KEYS: Record<keyof OmarchyPalette, string> = {
  mode: "mode",
  background: "background",
  darkBackground: "dark_background",
  darkerBackground: "darker_background",
  foreground: "foreground",
  muted: "muted",
  accent: "accent",
  selection: "selection",
  red: "red",
  yellow: "yellow",
  green: "green",
  blue: "blue",
} as const;

export const COLOR_KEYS = [
  "background",
  "darkBackground",
  "darkerBackground",
  "foreground",
  "muted",
  "accent",
  "selection",
  "red",
  "yellow",
  "green",
  "blue",
] as const;

const HEX_COLOR = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;

/**
 * Whether PrettyZap is running under Omarchy. Mirrors the old check from the
 * main process: environment markers or the presence of the user's Omarchy
 * shell config. PRETTYZAP_FORCE_TRAY forces the non-Omarchy path (custom
 * palette + tray) and PRETTYZAP_DISABLE_TRAY forces the Omarchy path.
 */
export function isRunningUnderOmarchy(): boolean {
  if (process.env.PRETTYZAP_FORCE_TRAY === "1") return false;
  if (process.env.PRETTYZAP_DISABLE_TRAY === "1") return true;
  return Boolean(process.env.OMARCHY_PATH)
    || Boolean(process.env.OMARCHY_VERSION)
    || fs.existsSync(path.join(os.homedir(), ".config/omarchy/shell.json"));
}

export function omarchyPalettePath(): string {
  const stateHome = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
  return path.join(stateHome, "omarchy", "current", "theme", "colors.toml");
}

export function prettyZapPalettePath(): string {
  const configHome = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(configHome, "prettyzap", "colors.toml");
}

export function resolvePaletteSources(): PaletteSources {
  const customFile = prettyZapPalettePath();
  return {
    custom: { kind: "custom", file: customFile, watchDir: path.dirname(customFile) },
    omarchy: isRunningUnderOmarchy()
      ? { kind: "omarchy", file: omarchyPalettePath(), watchDir: path.dirname(omarchyPalettePath()) }
      : undefined,
  };
}

/**
 * The palette that currently drives the System theme: a saved custom palette
 * overrides the live Omarchy palette; outside Omarchy only the custom file
 * (or nothing) applies.
 */
export function effectivePalette(): OmarchyPalette | undefined {
  return readPrettyZapPalette() ?? (isRunningUnderOmarchy() ? readOmarchyPalette() : undefined);
}

/**
 * Parse Omarchy's colors.toml format. Semantic keys are preferred. Themes
 * that only expose terminal ANSI colors are supported as a fallback, which
 * keeps the normal Omarchy palette contract authoritative when both formats
 * are present.
 */
export function parsePalette(source: string): OmarchyPalette | undefined {
  const entries = new Map<string, string>();
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*([a-z][a-z0-9_]*)\s*=\s*"(#[0-9a-fA-F]{6,8})"\s*(?:#.*)?$/);
    if (match && HEX_COLOR.test(match[2])) entries.set(match[1], match[2]);
  }

  const value = (key: keyof typeof PALETTE_KEYS): string | undefined =>
    entries.get(PALETTE_KEYS[key]);
  const ansi = (index: number): string | undefined => entries.get(`color${index}`);
  const background = value("background") ?? ansi(0);
  const darkBackground = value("darkBackground") ?? ansi(0) ?? background;
  const darkerBackground = value("darkerBackground") ?? ansi(0) ?? darkBackground;
  const foreground = value("foreground") ?? ansi(7);
  const muted = value("muted") ?? ansi(8) ?? ansi(3) ?? foreground;
  const accent = value("accent") ?? ansi(4) ?? ansi(6) ?? foreground;
  const selection = value("selection") ?? entries.get("selection_background") ?? ansi(7) ?? accent;
  if (!background || !darkBackground || !darkerBackground || !foreground || !muted || !accent || !selection) {
    return undefined;
  }

  return {
    mode: /^\s*mode\s*=\s*"light"/m.test(source) ? "light" : "dark",
    background,
    darkBackground,
    darkerBackground,
    foreground,
    muted,
    accent,
    selection,
    red: value("red") ?? ansi(1) ?? accent,
    yellow: value("yellow") ?? ansi(3) ?? foreground,
    green: value("green") ?? ansi(2) ?? accent,
    blue: value("blue") ?? ansi(4) ?? accent,
  };
}

/**
 * A neutral dark starting point for the custom palette (values from the
 * stock Omarchy "matte-black" theme, so the tweaker's defaults are familiar).
 */
export const DEFAULT_CUSTOM_PALETTE: OmarchyPalette = {
  mode: "dark",
  background: "#121212",
  darkBackground: "#0d0d0d",
  darkerBackground: "#090909",
  foreground: "#bebebe",
  muted: "#333333",
  accent: "#e68e0d",
  selection: "#2a2a2a",
  red: "#d35f5f",
  yellow: "#b91c1c",
  green: "#ffc107",
  blue: "#e68e0d",
};

export function paletteToRecord(palette: OmarchyPalette): { mode: PaletteMode; colors: PaletteColors } {
  return {
    mode: palette.mode,
    colors: {
      background: palette.background,
      darkBackground: palette.darkBackground,
      darkerBackground: palette.darkerBackground,
      foreground: palette.foreground,
      muted: palette.muted,
      accent: palette.accent,
      selection: palette.selection,
      red: palette.red,
      yellow: palette.yellow,
      green: palette.green,
      blue: palette.blue,
    },
  };
}

/** Validate an untrusted IPC payload and convert it back to a palette. */
export function recordToPalette(value: unknown): OmarchyPalette | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { mode?: unknown; colors?: unknown };
  if (candidate.mode !== "dark" && candidate.mode !== "light") return undefined;
  const colors = candidate.colors;
  if (!colors || typeof colors !== "object") return undefined;
  const record = colors as Record<string, unknown>;

  const color = (key: (typeof COLOR_KEYS)[number]): string | undefined => {
    const hex = record[key];
    return typeof hex === "string" && HEX_COLOR.test(hex) ? hex.toLowerCase() : undefined;
  };
  const palette: OmarchyPalette = {
    mode: candidate.mode,
    background: color("background") ?? "",
    darkBackground: color("darkBackground") ?? "",
    darkerBackground: color("darkerBackground") ?? "",
    foreground: color("foreground") ?? "",
    muted: color("muted") ?? "",
    accent: color("accent") ?? "",
    selection: color("selection") ?? "",
    red: color("red") ?? "",
    yellow: color("yellow") ?? "",
    green: color("green") ?? "",
    blue: color("blue") ?? "",
  };
  if (COLOR_KEYS.some((key) => palette[key] === "")) return undefined;
  return palette;
}

function formatToml(palette: OmarchyPalette): string {
  const lines = [
    "# PrettyZap custom palette — same keys as Omarchy's colors.toml.",
    "# Used by the System theme when PrettyZap runs outside Omarchy.",
    `mode = "${palette.mode}"`,
    "",
    `background = "${palette.background}"`,
    `dark_background = "${palette.darkBackground}"`,
    `darker_background = "${palette.darkerBackground}"`,
    `foreground = "${palette.foreground}"`,
    `muted = "${palette.muted}"`,
    `accent = "${palette.accent}"`,
    `selection = "${palette.selection}"`,
    `red = "${palette.red}"`,
    `yellow = "${palette.yellow}"`,
    `green = "${palette.green}"`,
    `blue = "${palette.blue}"`,
    "",
  ];
  return lines.join("\n");
}

export function writePrettyZapPalette(palette: OmarchyPalette, file = prettyZapPalettePath()): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporaryFile = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryFile, formatToml(palette), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryFile, file);
  } catch (error: unknown) {
    console.warn("Unable to save PrettyZap palette", error);
  }
}

export function readPrettyZapPalette(file = prettyZapPalettePath()): OmarchyPalette | undefined {
  try {
    return parsePalette(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

export function readOmarchyPalette(): OmarchyPalette | undefined {
  try {
    return parsePalette(fs.readFileSync(omarchyPalettePath(), "utf8"));
  } catch {
    return undefined;
  }
}

export function removePrettyZapPalette(file = prettyZapPalettePath()): void {
  try {
    fs.rmSync(file, { force: true });
  } catch (error: unknown) {
    console.warn("Unable to remove PrettyZap palette", error);
  }
}
