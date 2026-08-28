import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  MAX_ZOOM_FACTOR,
  MIN_ZOOM_FACTOR,
  OMARCHY_DEFAULT_BASE_SIZE,
  clampZoomFactor,
  parseFontBaseSize,
  readOmarchyFontBaseSize,
  resolveFontSources,
  zoomFactorForBaseSize,
} from "./omarchy-font";

const THEME_SHELL_TOML = `# generated per theme
[bar]
scale-with-font = true
size-horizontal  = 26

[font]
# base-size is the rem root for the type scale.
base-size = 12
`;

test("parses base-size from the [font] section", () => {
  assert.equal(parseFontBaseSize(THEME_SHELL_TOML), 12);
});

test("ignores base-size outside the [font] section", () => {
  assert.equal(parseFontBaseSize("[bar]\nbase-size = 30\n"), undefined);
});

test("ignores comments and blank lines", () => {
  assert.equal(parseFontBaseSize("[font]\n\n# base-size = 99\nbase-size = 10\n"), 10);
});

test("last assignment in a file wins, as Omarchy's own walker does", () => {
  assert.equal(parseFontBaseSize("[font]\nbase-size = 9\nbase-size = 14\n"), 14);
});

test("rejects non-positive and non-numeric values", () => {
  assert.equal(parseFontBaseSize("[font]\nbase-size = 0\n"), undefined);
  assert.equal(parseFontBaseSize("[font]\nbase-size = -3\n"), undefined);
  assert.equal(parseFontBaseSize('[font]\nbase-size = "big"\n'), undefined);
});

test("returns undefined when no [font] section exists", () => {
  assert.equal(parseFontBaseSize("[bar]\nsize-horizontal = 26\n"), undefined);
});

test("zoom mirrors Omarchy's base-size / 12 ratio", () => {
  assert.equal(zoomFactorForBaseSize(OMARCHY_DEFAULT_BASE_SIZE), 1);
  assert.equal(zoomFactorForBaseSize(6), 0.5);
  assert.equal(zoomFactorForBaseSize(24), 2);
});

test("zoom is clamped into Chromium's accepted range", () => {
  assert.equal(clampZoomFactor(0), MIN_ZOOM_FACTOR);
  assert.equal(clampZoomFactor(99), MAX_ZOOM_FACTOR);
  assert.equal(clampZoomFactor(Number.NaN), 1);
  assert.equal(zoomFactorForBaseSize(1), MIN_ZOOM_FACTOR);
});

test("the user layer overrides the theme layer", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prettyzap-font-"));
  const stateHome = path.join(root, "state");
  const configHome = path.join(root, "config");
  const themeDir = path.join(stateHome, "omarchy", "current", "theme");
  const userDir = path.join(configHome, "omarchy");
  fs.mkdirSync(themeDir, { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });

  const previousState = process.env.XDG_STATE_HOME;
  const previousConfig = process.env.XDG_CONFIG_HOME;
  process.env.XDG_STATE_HOME = stateHome;
  process.env.XDG_CONFIG_HOME = configHome;
  try {
    const [theme, user] = resolveFontSources();
    assert.equal(theme.file, path.join(themeDir, "shell.toml"));
    assert.equal(user.file, path.join(userDir, "shell.toml"));

    fs.writeFileSync(theme.file, THEME_SHELL_TOML);
    assert.equal(readOmarchyFontBaseSize(), 12);

    fs.writeFileSync(user.file, "[font]\nbase-size = 10\n");
    assert.equal(readOmarchyFontBaseSize(), 10);

    // A user file that says nothing about fonts leaves the theme in charge.
    fs.writeFileSync(user.file, "[bar]\nsize-horizontal = 44\n");
    assert.equal(readOmarchyFontBaseSize(), 12);

    // Neither layer present: no opinion at all.
    fs.rmSync(theme.file);
    fs.rmSync(user.file);
    assert.equal(readOmarchyFontBaseSize(), undefined);
  } finally {
    if (previousState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousState;
    if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfig;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
