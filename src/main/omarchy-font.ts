import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { isRunningUnderOmarchy } from "./palette";

/**
 * Omarchy font-scale handling, the type-scale counterpart to palette.ts.
 *
 * Omarchy's shell keeps its type scale in shell.toml under `[font] base-size`,
 * the rem root every `Style.font.<token>` derives from. Two layers are merged,
 * the user's winning, exactly as Omarchy's own Color.qml does it:
 *
 *   1. <XDG_STATE_HOME>/omarchy/current/theme/shell.toml   (the active theme)
 *   2. <XDG_CONFIG_HOME>/omarchy/shell.toml                (the user)
 *
 * Omarchy derives its scale as `base-size / 12` (Style.qml `fontScale`), so a
 * user who drops the shell to 10px is asking for 0.833. Reusing that ratio as
 * the WhatsApp zoom factor keeps the web view in step with the rest of the
 * desktop instead of inventing a second, unrelated notion of "font size".
 *
 * Node-only (no electron import) so it stays unit-testable, like palette.ts.
 */

/** The rem root Omarchy assumes when nothing overrides it (Style.qml). */
export const OMARCHY_DEFAULT_BASE_SIZE = 12;

/** Chromium's accepted zoom range; setZoomFactor throws outside it. */
export const MIN_ZOOM_FACTOR = 0.25;
export const MAX_ZOOM_FACTOR = 5;

export interface FontSource {
  kind: "theme" | "user";
  file: string;
  watchDir: string;
  /** Only react to this filename when the whole directory is watched. */
  fileName: string;
}

export function omarchyThemeShellTomlPath(): string {
  const stateHome = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
  return path.join(stateHome, "omarchy", "current", "theme", "shell.toml");
}

export function omarchyUserShellTomlPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(configHome, "omarchy", "shell.toml");
}

/** Lowest precedence first, so a later layer overrides an earlier one. */
export function resolveFontSources(): FontSource[] {
  const theme = omarchyThemeShellTomlPath();
  const user = omarchyUserShellTomlPath();
  return [
    { kind: "theme", file: theme, watchDir: path.dirname(theme), fileName: path.basename(theme) },
    { kind: "user", file: user, watchDir: path.dirname(user), fileName: path.basename(user) },
  ];
}

/**
 * Pull `base-size` out of a shell.toml. Section-aware because `base-size` is
 * only meaningful under `[font]`, and last-one-wins within a file, matching
 * Omarchy's own walker.
 */
export function parseFontBaseSize(source: string): number | undefined {
  let section = "";
  let found: number | undefined;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const header = line.match(/^\[([^\]]+)\]/);
    if (header) {
      section = header[1].trim().toLowerCase();
      continue;
    }
    if (section !== "font") continue;
    const match = line.match(/^base-size\s*=\s*(-?\d+)/);
    if (!match) continue;
    const value = Number.parseInt(match[1], 10);
    if (Number.isFinite(value) && value >= 1) found = value;
  }
  return found;
}

/** The merged `base-size` across both layers, or undefined if neither sets it. */
export function readOmarchyFontBaseSize(): number | undefined {
  let base: number | undefined;
  for (const source of resolveFontSources()) {
    let content: string;
    try {
      content = fs.readFileSync(source.file, "utf8");
    } catch {
      continue; // a missing layer just means "no opinion"
    }
    const parsed = parseFontBaseSize(content);
    if (parsed !== undefined) base = parsed;
  }
  return base;
}

export function clampZoomFactor(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_ZOOM_FACTOR, Math.max(MIN_ZOOM_FACTOR, value));
}

/** Omarchy's own ratio: Style.qml `fontScale = base-size / 12`. */
export function zoomFactorForBaseSize(baseSize: number): number {
  return clampZoomFactor(baseSize / OMARCHY_DEFAULT_BASE_SIZE);
}

/**
 * The zoom factor Omarchy is currently asking for, or undefined when we are
 * not running under Omarchy or it expresses no preference (in which case the
 * caller keeps the user's own zoom).
 */
export function omarchyZoomFactor(): number | undefined {
  if (!isRunningUnderOmarchy()) return undefined;
  const base = readOmarchyFontBaseSize();
  return base === undefined ? undefined : zoomFactorForBaseSize(base);
}
