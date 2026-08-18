import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  DEFAULT_CUSTOM_PALETTE,
  effectivePalette,
  parsePalette,
  paletteToRecord,
  readPrettyZapPalette,
  recordToPalette,
  removePrettyZapPalette,
  writePrettyZapPalette,
} from "./palette";

const TOKYO_NIGHT = `mode = "dark"

accent = "#7aa2f7"
selection = "#292e42"
muted = "#414868"

background = "#1a1b26"
dark_background = "#13141c"
darker_background = "#0e0e14"

foreground = "#a9b1d6"

red = "#f7768e"
yellow = "#e0af68"
green = "#9ece6a"
blue = "#7aa2f7"
`;

test("parsePalette reads Omarchy colors.toml values", () => {
  const palette = parsePalette(TOKYO_NIGHT);
  assert.ok(palette);
  assert.equal(palette.mode, "dark");
  assert.equal(palette.background, "#1a1b26");
  assert.equal(palette.darkBackground, "#13141c");
  assert.equal(palette.darkerBackground, "#0e0e14");
  assert.equal(palette.foreground, "#a9b1d6");
  assert.equal(palette.muted, "#414868");
  assert.equal(palette.accent, "#7aa2f7");
  assert.equal(palette.selection, "#292e42");
  assert.equal(palette.red, "#f7768e");
  assert.equal(palette.green, "#9ece6a");
});

test("parsePalette falls back to ANSI Omarchy colors when semantic keys are absent", () => {
  const palette = parsePalette(`accent = "#525e5a"
foreground = "#D6D0C5"
background = "#050505"
selection_background = "#D6D0C5"
color1 = "#da614e"
color2 = "#8B9388"
color3 = "#51605b"
color4 = "#75897F"
color5 = "#C2A46D"
`);
  assert.ok(palette);
  assert.equal(palette.background, "#050505");
  assert.equal(palette.darkBackground, "#050505");
  assert.equal(palette.darkerBackground, "#050505");
  assert.equal(palette.foreground, "#D6D0C5");
  assert.equal(palette.muted, "#51605b");
  assert.equal(palette.accent, "#525e5a");
  assert.equal(palette.selection, "#D6D0C5");
  assert.equal(palette.red, "#da614e");
  assert.equal(palette.yellow, "#51605b");
  assert.equal(palette.green, "#8B9388");
  assert.equal(palette.blue, "#75897F");
});

test("parsePalette detects light mode", () => {
  const palette = parsePalette('mode = "light"\nbackground = "#ffffff"\nforeground = "#111111"\nmuted = "#666666"\naccent = "#0000ff"\nselection = "#dddddd"\n');
  assert.ok(palette);
  assert.equal(palette.mode, "light");
});

test("parsePalette falls back for missing optional accents", () => {
  const palette = parsePalette('mode = "dark"\nbackground = "#000000"\nforeground = "#ffffff"\nmuted = "#888888"\naccent = "#ff0000"\nselection = "#333333"\n');
  assert.ok(palette);
  assert.equal(palette.red, "#ff0000"); // red falls back to accent
  assert.equal(palette.yellow, "#ffffff"); // yellow falls back to foreground
  assert.equal(palette.blue, "#ff0000");
});

test("parsePalette rejects missing required keys and bad hex", () => {
  assert.equal(parsePalette('mode = "dark"\nbackground = "#000000"\n'), undefined);
  assert.equal(
    parsePalette('mode = "dark"\nbackground = "red"\nforeground = "#ffffff"\nmuted = "#888888"\naccent = "#ff0000"\nselection = "#333333"\n'),
    undefined,
  );
});

test("recordToPalette validates untrusted IPC payloads", () => {
  assert.equal(recordToPalette(null), undefined);
  assert.equal(recordToPalette({ mode: "dark", colors: {} }), undefined);
  assert.equal(recordToPalette({ mode: "sepia", colors: {} }), undefined);

  const valid = paletteToRecord(DEFAULT_CUSTOM_PALETTE);
  const palette = recordToPalette({ mode: valid.mode, colors: valid.colors });
  assert.ok(palette);
  assert.deepEqual(palette, DEFAULT_CUSTOM_PALETTE);

  const invalidHex = {
    mode: "dark",
    colors: { ...valid.colors, accent: "not-a-color" },
  };
  assert.equal(recordToPalette(invalidHex), undefined);
});

test("write/read/remove custom palette round-trips atomically", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prettyzap-palette-"));
  const file = path.join(dir, "colors.toml");
  try {
    writePrettyZapPalette(DEFAULT_CUSTOM_PALETTE, file);
    const written = fs.readFileSync(file, "utf8");
    assert.ok(written.includes('mode = "dark"'));
    assert.ok(written.includes('accent = "#e68e0d"'));
    assert.ok(written.includes('dark_background = "#0d0d0d"'));
    assert.ok(!written.includes("darkBackground"));

    const parsed = readPrettyZapPalette(file);
    assert.deepEqual(parsed, DEFAULT_CUSTOM_PALETTE);

    removePrettyZapPalette(file);
    assert.equal(fs.existsSync(file), false);
    assert.equal(readPrettyZapPalette(file), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("default palette survives a full parse round-trip", () => {
  const record = paletteToRecord(DEFAULT_CUSTOM_PALETTE);
  const palette = recordToPalette({ mode: record.mode, colors: record.colors });
  assert.ok(palette);
  assert.deepEqual(palette, DEFAULT_CUSTOM_PALETTE);
});

function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void,
): void {
  const saved = new Map(Object.entries(vars).map(([key]) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prettyzap-palette-env-"));
  return dir;
}

const TOKYO_SOURCE = `mode = "dark"
background = "#1a1b26"
foreground = "#a9b1d6"
muted = "#414868"
accent = "#7aa2f7"
selection = "#292e42"
`;

function omarchyPaletteSource(dir: string): string {
  const file = path.join(dir, "omarchy", "current", "theme", "colors.toml");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, TOKYO_SOURCE);
  return file;
}

test("effectivePalette: custom palette overrides the Omarchy theme", () => {
  const configDir = makeDir();
  const stateDir = makeDir();
  try {
    withEnv(
      {
        XDG_CONFIG_HOME: configDir,
        XDG_STATE_HOME: stateDir,
        OMARCHY_PATH: "/test/omarchy", // force the Omarchy path
        PRETTYZAP_FORCE_TRAY: undefined,
      },
      () => {
        omarchyPaletteSource(stateDir);
        const fromOmarchy = effectivePalette();
        assert.equal(fromOmarchy?.accent, "#7aa2f7");

        writePrettyZapPalette(DEFAULT_CUSTOM_PALETTE);
        const fromCustom = effectivePalette();
        assert.deepEqual(fromCustom, DEFAULT_CUSTOM_PALETTE);
      },
    );
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("effectivePalette: outside Omarchy only the custom palette counts", () => {
  const configDir = makeDir();
  const stateDir = makeDir();
  try {
    withEnv(
      {
        XDG_CONFIG_HOME: configDir,
        XDG_STATE_HOME: stateDir,
        OMARCHY_PATH: undefined,
        PRETTYZAP_FORCE_TRAY: "1", // force the non-Omarchy path
      },
      () => {
        omarchyPaletteSource(stateDir);
        // The Omarchy file exists but must be ignored outside Omarchy.
        assert.equal(effectivePalette(), undefined);

        writePrettyZapPalette(DEFAULT_CUSTOM_PALETTE);
        assert.deepEqual(effectivePalette(), DEFAULT_CUSTOM_PALETTE);
      },
    );
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
