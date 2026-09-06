import type { SpawnSyncReturns } from "node:child_process";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HERDR_BUILTIN_GROUNDS, createHerdrAdapter, herdrMatchesRoleHexes, nearestHerdrBuiltinThemeNameFor, undoHerdr } from "../../src/adapters/herdr.js";
import { ACTIVE_ROW_MIN_VISIBLE_RATIO, MUTED_MIN_RATIO, TEXT_MIN_RATIO, type Role } from "../../src/constants.js";
import { contrastRatio, rgbDistance } from "../../src/palette/color.js";
import { resolveRoleHexes } from "../../src/palette/repair.js";
import { parseScheme, type Scheme } from "../../src/palette/scheme.js";
import { resolveSelectionAndBody } from "../../src/palette/selection.js";
import {
  ACTIVE_ROW_IDEAL_FRACTION,
  checkContrastPairs,
  herdrContrastPairs,
  resolveActiveRowAndText,
  type HerdrTokenSet,
} from "../../src/palette/surfaces.js";
import { loadCuratedThemePacks } from "../../src/palette/theme-pack-library.js";

/**
 * The exact role table `applyHerdrScheme` itself writes for `text` and
 * `subtext0` — CHM-50: herdr's own `body`/`muted` are repaired a second time
 * against the selected row (see resolveActiveRowAndText), so they can differ
 * from the plain `resolveRoleHexes` table a bare role lookup would give. Every
 * test that asserts on the written `text`/`subtext0` (or feeds
 * herdrMatchesRoleHexes) needs this, not the unrepaired table, or it is
 * pinning a value the adapter never actually writes.
 */
function expectedHerdrRoleHexes(scheme: Scheme): Record<Role, string> {
  const roleHexes = resolveRoleHexes(scheme);
  const { selection, body } = resolveSelectionAndBody(
    scheme.selectionBackground,
    roleHexes.ground,
    roleHexes.body,
    roleHexes.accent,
    [roleHexes.success, roleHexes.error],
  );
  const rowAndText = resolveActiveRowAndText(roleHexes.ground, body.hex, roleHexes.muted, [selection.hex], ACTIVE_ROW_IDEAL_FRACTION);
  return { ...roleHexes, body: rowAndText.textHex, muted: rowAndText.subtextHex };
}

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(currentDir, "fixtures", "herdr-config.toml");
const DUPLICATE_KEY_FIXTURE_PATH = path.join(currentDir, "fixtures", "herdr-config-duplicate-key.toml");
const UI_ACCENT_FIXTURE_PATH = path.join(currentDir, "fixtures", "herdr-config-ui-accent.toml");

const CRLF = "\r\n";
const LF = "\n";

// Real vendored scheme values (mbadolato/iTerm2-Color-Schemes) — never invented hex.
// See vendor/iterm2-color-schemes/windows-terminal/0x96f.json and "Aardvark Blue.json".
const ZEROX96F_SCHEME: Scheme = parseScheme({
  name: "0x96f",
  black: "#262427",
  red: "#ff666d",
  green: "#b3e03a",
  yellow: "#ffc739",
  blue: "#00cde8",
  purple: "#a392e8",
  cyan: "#9deaf6",
  white: "#fcfcfa",
  brightBlack: "#545452",
  brightRed: "#ff7e83",
  brightGreen: "#bee55e",
  brightYellow: "#ffd05e",
  brightBlue: "#1bd5eb",
  brightPurple: "#b0a3eb",
  brightCyan: "#acedf8",
  brightWhite: "#fcfcfa",
  background: "#262427",
  foreground: "#fcfcfa",
  cursorColor: "#fcfcfa",
  selectionBackground: "#fcfcfa",
});

const AARDVARK_BLUE_SCHEME: Scheme = parseScheme({
  name: "Aardvark Blue",
  black: "#191919",
  red: "#aa342e",
  green: "#4b8c0f",
  yellow: "#dbba00",
  blue: "#1370d3",
  purple: "#c43ac3",
  cyan: "#008eb0",
  white: "#bebebe",
  brightBlack: "#525252",
  brightRed: "#f05b50",
  brightGreen: "#95dc55",
  brightYellow: "#ffe763",
  brightBlue: "#60a4ec",
  brightPurple: "#e26be2",
  brightCyan: "#60b6cb",
  brightWhite: "#f7f7f7",
  background: "#102040",
  foreground: "#dddddd",
  cursorColor: "#007acc",
  selectionBackground: "#bfdbfe",
});

// Real vendored scheme values (mbadolato/iTerm2-Color-Schemes), taken from
// the bundled github-light pack itself — see themes/github-light.json.
// github-light has no Herdr built-in (see CHM-21's ticket body), so it's
// what exercises the appearance-fallback branch below.
const GITHUB_LIGHT_SCHEME: Scheme = parseScheme({
  name: "GitHub Light Default",
  black: "#24292f",
  red: "#cf222e",
  green: "#116329",
  yellow: "#4d2d00",
  blue: "#0969da",
  purple: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#633c01",
  brightBlue: "#218bff",
  brightPurple: "#a475f9",
  brightCyan: "#3192aa",
  brightWhite: "#8c959f",
  background: "#ffffff",
  foreground: "#1f2328",
  cursorColor: "#0969da",
  selectionBackground: "#1f2328",
});

// Real bundled pack slugs (see themes/index.json), used to drive the
// slug → Herdr built-in mapping under test rather than inventing slugs that
// mean nothing. catppuccin-dark and dracula-dark both ship a Herdr
// built-in; monokai-dark and github-light do not — see CHM-21's ticket
// body for the authoritative lists of each.
const MAPPED_DARK_SLUG = "catppuccin-dark";
const MAPPED_DARK_HERDR_THEME = "catppuccin";
const OTHER_MAPPED_DARK_SLUG = "dracula-dark";
const OTHER_MAPPED_DARK_HERDR_THEME = "dracula";
const UNMAPPED_DARK_SLUG = "monokai-dark";
const UNMAPPED_LIGHT_SLUG = "github-light";
// kanagawa-light and rose-pine-light each have a real Herdr built-in
// (kanagawa-lotus, rose-pine-dawn respectively) that the mapping table used
// to omit for no reason — CHM-28, problem 1.
const KANAGAWA_LIGHT_SLUG = "kanagawa-light";
const KANAGAWA_LIGHT_HERDR_THEME = "kanagawa-lotus";
const ROSE_PINE_LIGHT_SLUG = "rose-pine-light";
const ROSE_PINE_LIGHT_HERDR_THEME = "rose-pine-dawn";

/** Herdr's own [theme.custom] token names for Chameleon's six roles, in role order — see ROLE_TO_HERDR_TOKEN in adapters/herdr.ts. */
const HERDR_TOKENS_IN_ROLE_ORDER = ["sidebar_bg", "text", "accent", "subtext0", "green", "red"];

/**
 * Every token Herdr's own [theme.custom] table accepts — copied verbatim
 * from probing `herdr config check` (see CHM-28's ticket body), the same way
 * HERDR_BUILTIN_THEME_NAMES below is copied from Herdr's own bogus-theme-name
 * diagnostic. Declared independently of adapters/herdr.ts's own
 * HERDR_ACCEPTED_CUSTOM_TOKENS so this test proves the adapter's behaviour
 * against Herdr's real vocabulary, not against its own copy of it.
 */
const HERDR_ACCEPTED_CUSTOM_TOKENS = new Set([
  "sidebar_bg",
  "active_row_bg",
  "selection_bg",
  "panel_bg",
  "surface_dim",
  "surface0",
  "surface1",
  "overlay0",
  "overlay1",
  "text",
  "subtext0",
  "accent",
  "red",
  "green",
  "blue",
  "mauve",
  "peach",
  "teal",
  "yellow",
]);

/**
 * Herdr's own built-in theme names, copied verbatim from the "valid themes:"
 * list Herdr prints for an unrecognised `[theme].name` — see this ticket's
 * body (CHM-28) and HERDR_BUILTIN_THEME_NAMES in adapters/herdr.ts. Declared
 * independently here for the same reason as HERDR_ACCEPTED_CUSTOM_TOKENS
 * above.
 */
const HERDR_BUILTIN_THEME_NAMES = new Set([
  "catppuccin",
  "catppuccin-latte",
  "terminal",
  "tokyo-night",
  "tokyo-night-day",
  "dracula",
  "nord",
  "gruvbox",
  "gruvbox-light",
  "one-dark",
  "one-light",
  "solarized",
  "solarized-light",
  "kanagawa",
  "kanagawa-lotus",
  "rose-pine",
  "rose-pine-dawn",
  "vesper",
]);

/**
 * True when every line of `original`, in order, appears verbatim somewhere
 * in `result` — i.e. `original`'s lines form a subsequence of `result`'s.
 */
function everyOriginalLineSurvivesInOrder(original: string, result: string): boolean {
  const originalLines = original.split(/\r\n|\n/);
  const resultLines = result.split(/\r\n|\n/);
  let originalIndex = 0;
  for (const resultLine of resultLines) {
    if (originalIndex < originalLines.length && resultLine === originalLines[originalIndex]) {
      originalIndex += 1;
    }
  }
  return originalIndex === originalLines.length;
}

/**
 * The fixture's lines minus the one Chameleon is this ticket's job to
 * *replace* — the pre-existing `[theme]` name. Everything else, [ui] and
 * the user's own [theme.custom] overrides included, must round-trip
 * untouched.
 */
function linesUnrelatedToChameleonEdits(text: string, eol: string): string {
  return text
    .split(eol)
    .filter((line) => !/^\s*name\s*=/.test(line))
    .join(eol);
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function usesOnlyLineEnding(text: string, eol: string): boolean {
  return eol === CRLF ? !/(?<!\r)\n/.test(text) : !text.includes("\r");
}

/**
 * `tableName`'s own body text within `text` — everything after its `[tableName]`
 * header, up to the next table header or end of file. [theme.custom] and [ui]
 * both use the literal key `accent` (see UI_ACCENT_KEY in adapters/herdr.ts),
 * so a plain `countOccurrences(text, "accent = ")` conflates the two tables;
 * this scopes the count to the one table a test actually cares about.
 */
function tableBodyText(text: string, eol: string, tableName: string): string {
  const lines = text.split(eol);
  const escapedTableName = tableName.replace(/\./g, "\\.");
  const headerRegex = new RegExp(`^\\s*\\[${escapedTableName}\\]\\s*(#.*)?$`);
  const anyHeaderRegex = /^\s*\[[^[\]]+\]\s*(#.*)?$/;

  const headerIndex = lines.findIndex((line) => headerRegex.test(line));
  if (headerIndex === -1) return "";

  const nextHeaderOffset = lines.slice(headerIndex + 1).findIndex((line) => anyHeaderRegex.test(line));
  const bodyEndIndex = nextHeaderOffset === -1 ? lines.length : headerIndex + 1 + nextHeaderOffset;

  return lines.slice(headerIndex + 1, bodyEndIndex).join(eol);
}

function makeSpawnResult(overrides: Partial<SpawnSyncReturns<string>> = {}): SpawnSyncReturns<string> {
  return {
    pid: 1234,
    output: [null, "", ""],
    stdout: "",
    stderr: "",
    status: 0,
    signal: null,
    ...overrides,
  };
}

// The hostile fixture already carries \n only (see .gitattributes, which
// pins it there regardless of core.autocrlf) — both line-ending variants
// are derived from it here so the test never depends on how git or the
// filesystem happened to check the file out.
const LF_FIXTURE = readFileSync(FIXTURE_PATH, "utf8").replace(/\r\n/g, LF);
const CRLF_FIXTURE = LF_FIXTURE.replace(/\n/g, CRLF);

describe.each([
  { label: "CRLF", fixture: CRLF_FIXTURE, eol: CRLF },
  { label: "LF", fixture: LF_FIXTURE, eol: LF },
])("herdr adapter — $label fixture", ({ fixture, eol }) => {
  let configDir: string;
  let configPath: string;

  beforeEach(() => {
    configDir = mkdtempSync(path.join(tmpdir(), "chameleon-herdr-"));
    configPath = path.join(configDir, "config.toml");
    writeFileSync(configPath, fixture, "utf8");
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it("detects Herdr by the presence of its config.toml", () => {
    expect(createHerdrAdapter(configPath).detect()).toBe(true);
    expect(createHerdrAdapter(path.join(configDir, "missing.toml")).detect()).toBe(false);
  });

  it("reads a hostile config — comments and a pre-existing [theme.custom] included", () => {
    const config = createHerdrAdapter(configPath).read();
    expect(config.theme.name).toBe("legacy-theme");
    expect(config.theme.custom["banner"]).toBe("#112233");
    expect(config.theme.custom["accent_override"]).toBe("#445566");
  });

  it("round-trips every original line byte-identical outside the theme name, its own line endings included", () => {
    createHerdrAdapter(configPath).apply(ZEROX96F_SCHEME, MAPPED_DARK_SLUG);

    const resultText = readFileSync(configPath, "utf8");
    expect(everyOriginalLineSurvivesInOrder(linesUnrelatedToChameleonEdits(fixture, eol), resultText)).toBe(true);
    expect(usesOnlyLineEnding(resultText, eol)).toBe(true);
  });

  it("leaves [ui]'s own behaviour settings and their comments untouched, apart from the accent CHM-23 now sets", () => {
    createHerdrAdapter(configPath).apply(ZEROX96F_SCHEME, MAPPED_DARK_SLUG);

    const resultText = readFileSync(configPath, "utf8");
    expect(resultText).toContain("# status bar lives here, out of scope for Chameleon");
    expect(resultText).toContain('pane_border_style = "rounded" # I like rounded borders');
    expect(resultText).toContain("show_status_bar = true");
    expect(resultText).toContain('socket_path = "/tmp/herdr.sock"');

    const config = createHerdrAdapter(configPath).read();
    expect(config.ui.accent).toBe(resolveRoleHexes(ZEROX96F_SCHEME).accent);
  });

  it("leaves exactly one name key, resolving to the pack's own Herdr built-in — not the scheme's display name", () => {
    expect(fixture).toContain('name = "legacy-theme"');

    createHerdrAdapter(configPath).apply(ZEROX96F_SCHEME, MAPPED_DARK_SLUG);

    const resultText = readFileSync(configPath, "utf8");
    expect(countOccurrences(resultText, "name = ")).toBe(1);
    // The scheme's own name is "0x96f" (see ZEROX96F_SCHEME); a name of
    // "0x96f" or "Catppuccin Mocha" is exactly the CHM-21 regression — Herdr
    // has no built-in by either name and silently ignores it.
    expect(resultText).toContain(`name = "${MAPPED_DARK_HERDR_THEME}"`);
    expect(resultText).not.toContain('name = "0x96f"');
  });

  it("keeps a user's own [theme.custom] overrides untouched, alongside Chameleon's own tokens under Herdr's own names", () => {
    createHerdrAdapter(configPath).apply(ZEROX96F_SCHEME, MAPPED_DARK_SLUG);

    const resultText = readFileSync(configPath, "utf8");
    expect(resultText).toContain("# my own overrides, do not remove");
    expect(resultText).toContain('banner = "#112233"');
    expect(resultText).toContain('accent_override = "#445566"');

    const config = createHerdrAdapter(configPath).read();
    for (const herdrToken of HERDR_TOKENS_IN_ROLE_ORDER) {
      expect(config.theme.custom[herdrToken]).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(config.theme.custom["banner"]).toBe("#112233");
    expect(config.theme.custom["accent_override"]).toBe("#445566");
  });

  it("is idempotent — applying the same pack twice produces the same file", () => {
    const adapter = createHerdrAdapter(configPath);

    adapter.apply(ZEROX96F_SCHEME, MAPPED_DARK_SLUG);
    const afterFirstApply = readFileSync(configPath, "utf8");
    adapter.apply(ZEROX96F_SCHEME, MAPPED_DARK_SLUG);
    const afterSecondApply = readFileSync(configPath, "utf8");

    expect(afterSecondApply).toBe(afterFirstApply);
    // One marker pair per table Chameleon owns — [theme.custom] and [ui].
    expect(countOccurrences(afterSecondApply, "# ch:begin")).toBe(2);
  });

  it("upserts the marked block in place when a different pack is applied later, instead of accumulating", () => {
    const adapter = createHerdrAdapter(configPath);

    adapter.apply(ZEROX96F_SCHEME, MAPPED_DARK_SLUG);
    adapter.apply(AARDVARK_BLUE_SCHEME, OTHER_MAPPED_DARK_SLUG);

    const resultText = readFileSync(configPath, "utf8");
    // One marker pair per table Chameleon owns — [theme.custom] and [ui].
    expect(countOccurrences(resultText, "# ch:begin")).toBe(2);
    expect(countOccurrences(resultText, "# ch:end")).toBe(2);
    expect(resultText).toContain(`name = "${OTHER_MAPPED_DARK_HERDR_THEME}"`);
    expect(resultText).not.toContain(`name = "${MAPPED_DARK_HERDR_THEME}"`);
    // The user's own overrides are still there, untouched by the second apply.
    expect(resultText).toContain('banner = "#112233"');
  });

  it("writes a backup before every apply, and undo restores it exactly", () => {
    createHerdrAdapter(configPath).apply(ZEROX96F_SCHEME, MAPPED_DARK_SLUG);
    expect(readFileSync(configPath, "utf8")).not.toBe(fixture);
    expect(readFileSync(`${configPath}.chameleon-backup`, "utf8")).toBe(fixture);

    undoHerdr(configPath);
    expect(readFileSync(configPath, "utf8")).toBe(fixture);
  });
});

// CHM-27: this is the exact comparison `ch current`/`ch doctor` use to
// notice a target that has drifted from the recorded pack.
describe("herdrMatchesRoleHexes", () => {
  let configDir: string;
  let configPath: string;

  beforeEach(() => {
    configDir = mkdtempSync(path.join(tmpdir(), "chameleon-herdr-drift-"));
    configPath = path.join(configDir, "config.toml");
    writeFileSync(configPath, LF_FIXTURE, "utf8");
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it("matches right after apply", () => {
    const adapter = createHerdrAdapter(configPath);
    adapter.apply(ZEROX96F_SCHEME, MAPPED_DARK_SLUG);

    expect(herdrMatchesRoleHexes(adapter.read(), expectedHerdrRoleHexes(ZEROX96F_SCHEME))).toBe(true);
  });

  it("does not match a scheme other than the one last applied", () => {
    const adapter = createHerdrAdapter(configPath);
    adapter.apply(ZEROX96F_SCHEME, MAPPED_DARK_SLUG);

    expect(herdrMatchesRoleHexes(adapter.read(), resolveRoleHexes(AARDVARK_BLUE_SCHEME))).toBe(false);
  });

  it("does not match a config that was never themed by Chameleon at all", () => {
    const config = createHerdrAdapter(configPath).read();

    expect(herdrMatchesRoleHexes(config, resolveRoleHexes(ZEROX96F_SCHEME))).toBe(false);
  });
});

describe("herdr adapter — edge cases", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(path.join(tmpdir(), "chameleon-herdr-edge-"));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it("names the file and the problem when a config it must edit is shaped wrong", () => {
    const malformedPath = path.join(configDir, "malformed.toml");
    writeFileSync(malformedPath, "[ui]\nshow_status_bar = true\n", "utf8");
    expect(() => createHerdrAdapter(malformedPath).read()).toThrow(malformedPath);
  });

  it("refuses to apply when there is no config.toml to edit", () => {
    const adapter = createHerdrAdapter(path.join(configDir, "missing.toml"));
    expect(() => adapter.apply(ZEROX96F_SCHEME, MAPPED_DARK_SLUG)).toThrow();
  });

  it("creates [theme.custom] when the config does not have one yet", () => {
    const configPath = path.join(configDir, "config.toml");
    writeFileSync(configPath, '[theme]\nname = "builtin"\n', "utf8");

    createHerdrAdapter(configPath).apply(ZEROX96F_SCHEME, MAPPED_DARK_SLUG);

    const config = createHerdrAdapter(configPath).read();
    for (const herdrToken of HERDR_TOKENS_IN_ROLE_ORDER) {
      expect(config.theme.custom[herdrToken]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("detects false, cleanly, when APPDATA names no config", () => {
    // Stubbed rather than relying on the host's own environment being
    // unset — this machine has a real Herdr install, config.toml included.
    vi.stubEnv("APPDATA", "");
    try {
      expect(createHerdrAdapter(undefined).detect()).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// CHM-21: Chameleon wrote a theme name Herdr does not recognise ("Catppuccin
// Mocha", the Windows Terminal scheme's own display name) and five colour
// tokens Herdr does not document. Herdr silently ignored all of it. These
// tests pin the fix directly: the name comes from the pack's own slug, not
// the scheme, and only Herdr's documented tokens are ever written.
describe("herdr adapter — theme name and token mapping", () => {
  let configDir: string;
  let configPath: string;

  beforeEach(() => {
    configDir = mkdtempSync(path.join(tmpdir(), "chameleon-herdr-mapping-"));
    configPath = path.join(configDir, "config.toml");
    writeFileSync(configPath, LF_FIXTURE, "utf8");
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it("writes a pack's own Herdr built-in, decoupled from the applied scheme's display name", () => {
    // ZEROX96F_SCHEME's own name is "0x96f" — irrelevant here. What decides
    // the written name is the slug, matched against Herdr's own picker.
    createHerdrAdapter(configPath).apply(ZEROX96F_SCHEME, MAPPED_DARK_SLUG);

    const config = createHerdrAdapter(configPath).read();
    expect(config.theme.name).toBe(MAPPED_DARK_HERDR_THEME);
  });

  // CHM-41: a slug with no family match used to fall back to a generic
  // "terminal"/"one-light" regardless of the pack's own colours. It now
  // falls back to whichever built-in's ground is nearest this pack's own
  // ground — here, Aardvark Blue's #102040 lands nearest "solarized"
  // (#002b36), not the flat black "terminal" used to write unconditionally.
  it("falls back to the built-in with the nearest ground for a dark pack with no family match, and still carries its own colours", () => {
    createHerdrAdapter(configPath).apply(AARDVARK_BLUE_SCHEME, UNMAPPED_DARK_SLUG);

    const config = createHerdrAdapter(configPath).read();
    expect(config.theme.name).toBe("solarized");

    const expectedColorTable = expectedHerdrRoleHexes(AARDVARK_BLUE_SCHEME);
    expect(config.theme.custom["sidebar_bg"]).toBe(expectedColorTable.ground);
    expect(config.theme.custom["text"]).toBe(expectedColorTable.body);
    expect(config.theme.custom["accent"]).toBe(expectedColorTable.accent);
    expect(config.theme.custom["subtext0"]).toBe(expectedColorTable.muted);
    expect(config.theme.custom["green"]).toBe(expectedColorTable.success);
    expect(config.theme.custom["red"]).toBe(expectedColorTable.error);
  });

  // GitHub Light's own ground, #ffffff, happens to land nearest "one-light"
  // (#fafafa) either way — this pins that the light side of the same
  // nearest-ground fallback still picks a real built-in, not that it always
  // agrees with the old hardcoded fallback.
  it("falls back to the built-in with the nearest ground for a light pack with no family match", () => {
    createHerdrAdapter(configPath).apply(GITHUB_LIGHT_SCHEME, UNMAPPED_LIGHT_SLUG);

    const config = createHerdrAdapter(configPath).read();
    expect(config.theme.name).toBe("one-light");
  });

  it("never writes the invented tokens this ticket exists to fix", () => {
    createHerdrAdapter(configPath).apply(ZEROX96F_SCHEME, MAPPED_DARK_SLUG);

    const config = createHerdrAdapter(configPath).read();
    expect(config.theme.custom["ground"]).toBeUndefined();
    expect(config.theme.custom["body"]).toBeUndefined();
    expect(config.theme.custom["muted"]).toBeUndefined();
    expect(config.theme.custom["success"]).toBeUndefined();
    expect(config.theme.custom["error"]).toBeUndefined();
  });

  // CHM-28, problem 1: these two packs each have a real Herdr built-in that
  // the mapping table used to omit for no reason, so they fell back to
  // "terminal"/"one-light" instead.
  it("maps kanagawa-light to its real Herdr built-in, kanagawa-lotus", () => {
    createHerdrAdapter(configPath).apply(GITHUB_LIGHT_SCHEME, KANAGAWA_LIGHT_SLUG);

    const config = createHerdrAdapter(configPath).read();
    expect(config.theme.name).toBe(KANAGAWA_LIGHT_HERDR_THEME);
  });

  it("maps rose-pine-light to its real Herdr built-in, rose-pine-dawn", () => {
    createHerdrAdapter(configPath).apply(GITHUB_LIGHT_SCHEME, ROSE_PINE_LIGHT_SLUG);

    const config = createHerdrAdapter(configPath).read();
    expect(config.theme.name).toBe(ROSE_PINE_LIGHT_HERDR_THEME);
  });

  // CHM-28: the valid theme list must come from Herdr rather than a
  // hardcoded table, so it cannot drift. This sweeps every slug this file
  // exercises — mapped, unmapped, and both appearances — and checks the
  // written name against Herdr's own reported list rather than against
  // adapters/herdr.ts's own copy of it (see HERDR_BUILTIN_THEME_NAMES above).
  it("never writes a [theme].name outside Herdr's own reported list of valid themes", () => {
    const adapter = createHerdrAdapter(configPath);
    const cases: ReadonlyArray<[Scheme, string]> = [
      [ZEROX96F_SCHEME, MAPPED_DARK_SLUG],
      [AARDVARK_BLUE_SCHEME, OTHER_MAPPED_DARK_SLUG],
      [AARDVARK_BLUE_SCHEME, UNMAPPED_DARK_SLUG],
      [GITHUB_LIGHT_SCHEME, UNMAPPED_LIGHT_SLUG],
      [GITHUB_LIGHT_SCHEME, KANAGAWA_LIGHT_SLUG],
      [GITHUB_LIGHT_SCHEME, ROSE_PINE_LIGHT_SLUG],
    ];

    for (const [scheme, slug] of cases) {
      adapter.apply(scheme, slug);
      const config = adapter.read();
      expect(HERDR_BUILTIN_THEME_NAMES.has(config.theme.name ?? "")).toBe(true);
    }
  });
});

// CHM-41: a pack with no Herdr built-in used to fall back to a generic
// terminal (dark) or one-light (light) base regardless of its own colours,
// leaving the tab bar, borders and cursor — none of them reachable by any
// [theme.custom] token — stuck on that base's own colours rather than
// anything close to the theme actually picked. These pin the replacement
// directly: nearestHerdrBuiltinThemeNameFor, fed each unmapped bundled
// pack's own ground, against the exact distances measured in this ticket's
// own body. Every ground below is real — copied verbatim from that pack's
// own bundled payload (see themes/<slug>.json's payloads.herdr.ground) —
// never invented.
describe("herdr adapter — nearest built-in ground fallback (CHM-41)", () => {
  // slug -> [ground, expected nearest built-in, its measured RGB distance]
  const UNMAPPED_PACK_GROUNDS: ReadonlyArray<[string, string, string, number]> = [
    ["ayu-dark", "#1f2430", "catppuccin", 6.40],
    ["monokai-dark", "#272822", "gruvbox", 6.08],
    ["everforest-dark", "#232a2e", "gruvbox", 8.06],
    ["github-dark", "#0d1117", "vesper", 7.68],
    ["ayu-light", "#f8f9fa", "one-light", 2.24],
    ["github-light", "#ffffff", "one-light", 8.66],
    ["night-owl-light", "#ffffff", "one-light", 8.66],
    ["nord-light", "#e5e9f0", "tokyo-night-day", 12.08],
    ["everforest-light", "#efebd4", "gruvbox-light", 18.68],
    ["night-owl-dark", "#011627", "rose-pine", 24.21],
    // CHM-62's three additions — none has a Herdr built-in of its own either.
    ["jellybeans", "#121212", "vesper", 3.46],
    ["shades-of-purple", "#1e1d40", "catppuccin", 18.03],
    ["ayu-dark-deep", "#0b0e14", "vesper", 6.71],
  ];

  it.each(UNMAPPED_PACK_GROUNDS)("picks %s's nearest built-in, %s, for ground %s", (_slug, groundHex, expectedThemeName) => {
    expect(nearestHerdrBuiltinThemeNameFor(groundHex)).toBe(expectedThemeName);
  });

  it.each(UNMAPPED_PACK_GROUNDS)("never falls back to terminal for %s when a closer built-in exists", (_slug, groundHex) => {
    expect(nearestHerdrBuiltinThemeNameFor(groundHex)).not.toBe("terminal");
  });

  // The stated bound: every measured distance above is comfortably under 30
  // (the worst, night-owl-dark, is ~24.2), against the old fallback's ~62+
  // for everforest-dark on terminal alone — see this ticket's own body.
  const MAX_ACCEPTABLE_HERDR_BUILTIN_GROUND_DISTANCE = 30;

  it.each(UNMAPPED_PACK_GROUNDS)("keeps %s's chosen base within the stated distance of its own ground", (_slug, groundHex, expectedThemeName, measuredDistance) => {
    const chosenThemeName = nearestHerdrBuiltinThemeNameFor(groundHex);
    const chosenGroundHex = HERDR_BUILTIN_GROUNDS[chosenThemeName];
    expect(chosenGroundHex).toBeDefined();
    const distance = rgbDistance(groundHex, chosenGroundHex ?? "");
    expect(distance).toBeCloseTo(measuredDistance, 1);
    expect(distance).toBeLessThan(MAX_ACCEPTABLE_HERDR_BUILTIN_GROUND_DISTANCE);
  });
});

// CHM-28, problem 2: a pack with no Herdr built-in used to set only six
// [theme.custom] tokens, leaving every other panel, row and surface Herdr
// paints in the fallback theme's own colours — only the accent visibly
// changed. These tests pin the fix: Chameleon now derives and writes
// Herdr's full 19-token vocabulary, and never a key outside it.
describe("herdr adapter — full custom token vocabulary (CHM-28)", () => {
  let configDir: string;
  let configPath: string;

  beforeEach(() => {
    configDir = mkdtempSync(path.join(tmpdir(), "chameleon-herdr-tokens-"));
    configPath = path.join(configDir, "config.toml");
    // A minimal config with no pre-existing [theme.custom] of its own — the
    // vocabulary tests below check exactly what Chameleon itself writes, not
    // a mix of that and a user's own unrelated custom keys (already covered
    // by the "keeps a user's own overrides untouched" tests elsewhere).
    writeFileSync(configPath, '[theme]\nname = "builtin"\n', "utf8");
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it("writes every one of Herdr's 19 accepted tokens for a pack with no Herdr built-in", () => {
    createHerdrAdapter(configPath).apply(GITHUB_LIGHT_SCHEME, UNMAPPED_LIGHT_SLUG);

    const config = createHerdrAdapter(configPath).read();
    for (const token of HERDR_ACCEPTED_CUSTOM_TOKENS) {
      expect(config.theme.custom[token]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("never writes a [theme.custom] key outside Herdr's own accepted vocabulary", () => {
    createHerdrAdapter(configPath).apply(GITHUB_LIGHT_SCHEME, UNMAPPED_LIGHT_SLUG);

    const config = createHerdrAdapter(configPath).read();
    for (const key of Object.keys(config.theme.custom)) {
      expect(HERDR_ACCEPTED_CUSTOM_TOKENS.has(key)).toBe(true);
    }
  });

  it("repairs selection_bg rather than passing through a selection colour that fails its floors", () => {
    // GitHub Light's authored selectionBackground is literally its own body
    // colour (#1f2328) — invisible as a highlight and unreadable underneath
    // it at once (CHM-30). Passing it straight through, the way this
    // adapter used to, would ship that bug into Herdr.
    createHerdrAdapter(configPath).apply(GITHUB_LIGHT_SCHEME, UNMAPPED_LIGHT_SLUG);

    const config = createHerdrAdapter(configPath).read();
    expect(config.theme.custom["selection_bg"]).not.toBe(GITHUB_LIGHT_SCHEME.selectionBackground);
    expect(config.theme.custom["selection_bg"]).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("draws the extra accent tokens straight from the scheme's own base ANSI slots", () => {
    createHerdrAdapter(configPath).apply(GITHUB_LIGHT_SCHEME, UNMAPPED_LIGHT_SLUG);

    const config = createHerdrAdapter(configPath).read();
    expect(config.theme.custom["blue"]).toBe(GITHUB_LIGHT_SCHEME.blue);
    expect(config.theme.custom["teal"]).toBe(GITHUB_LIGHT_SCHEME.cyan);
    expect(config.theme.custom["mauve"]).toBe(GITHUB_LIGHT_SCHEME.purple);
    expect(config.theme.custom["yellow"]).toBe(GITHUB_LIGHT_SCHEME.yellow);
  });

  it("gives panel_bg, active_row_bg and the surface scale distinct tones between ground and body", () => {
    createHerdrAdapter(configPath).apply(GITHUB_LIGHT_SCHEME, UNMAPPED_LIGHT_SLUG);

    const config = createHerdrAdapter(configPath).read();
    const expectedColorTable = resolveRoleHexes(GITHUB_LIGHT_SCHEME);
    // panel_bg matches sidebar_bg (both are the pack's own ground) — the
    // fix here is that it is set at all, not that it differs from ground.
    expect(config.theme.custom["panel_bg"]).toBe(expectedColorTable.ground);
    // The rest of the scale must actually move away from ground and body,
    // not just repeat one of them — otherwise "the row colours changed" is
    // a name change with no visible effect, exactly what this ticket is
    // about.
    const surfaceTokens = ["surface_dim", "surface0", "surface1", "overlay0", "overlay1", "active_row_bg"];
    for (const token of surfaceTokens) {
      const value = config.theme.custom[token];
      expect(value).not.toBe(expectedColorTable.ground);
      expect(value).not.toBe(expectedColorTable.body);
    }
  });

  it("stays idempotent across the full token set — applying the same pack twice produces the same file", () => {
    const adapter = createHerdrAdapter(configPath);

    adapter.apply(GITHUB_LIGHT_SCHEME, UNMAPPED_LIGHT_SLUG);
    const afterFirstApply = readFileSync(configPath, "utf8");
    adapter.apply(GITHUB_LIGHT_SCHEME, UNMAPPED_LIGHT_SLUG);
    const afterSecondApply = readFileSync(configPath, "utf8");

    expect(afterSecondApply).toBe(afterFirstApply);
  });
});

// CHM-50: CHM-48 fixed the selected row's subtext0 by moving active_row_bg
// almost onto sidebar_bg — readable, but no longer visibly selected in 17 of
// the 26 bundled packs (dracula-dark measured 1.00, the same colour). CHM-75
// then found CHM-50's own fix had settled for too little: subtext0-on-row
// only had to clear MUTED_MIN_RATIO, the floor for text a reader is meant to
// skim past, while on the selected row subtext0 carries the agent's own
// title and provider — the thing being read. CHM-75's own fix, though, still
// treated row visibility as the thing to maximise and text as the
// constraint: monokai-dark's row settled at 2.12 against sidebar (visibility
// to spare against a 2.0 floor) and subtext0 was dragged to 4.63 on top of
// it — legal, and the least readable text on screen. CHM-80 inverts that:
// the row takes the smallest lift that clears its own (lower) visibility
// floor, and text keeps whatever contrast that leaves, which turns out to be
// nearly all of it (monokai-dark's subtext0 now reads 7.49). These tests pin
// the combined fix: row-vs-sidebar visibility, text-on-row and
// subtext0-on-row are asserted together, per pack, so a fix that only checks
// one of the three (the way CHM-48 shipped) fails here, and subtext0-on-row's
// own floor is MUTED_MIN_RATIO only as a non-regression guarantee —
// CHM-75's own target, TEXT_MIN_RATIO, is asserted separately below.
describe("herdr adapter — active row vs sidebar, text and subtext0 (CHM-50, CHM-75, CHM-80)", () => {
  function customTokensFor(scheme: Scheme, slug: string): Record<string, string> {
    const configDir = mkdtempSync(path.join(tmpdir(), "chameleon-herdr-active-row-"));
    const configPath = path.join(configDir, "config.toml");
    writeFileSync(configPath, '[theme]\nname = "builtin"\n', "utf8");
    try {
      createHerdrAdapter(configPath).apply(scheme, slug);
      return createHerdrAdapter(configPath).read().theme.custom;
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  }

  interface ActiveRowTokens {
    readonly sidebarBg: string;
    readonly activeRowBg: string;
    readonly text: string;
    readonly subtext0: string;
  }

  function activeRowTokensFor(slug: string): ActiveRowTokens {
    const packs = loadCuratedThemePacks();
    const pack = packs.find((candidate) => candidate.manifest.slug === slug);
    if (!pack) throw new Error(`fixture pack not found: ${slug}`);

    const customTokens = customTokensFor(pack.payloads["windows-terminal"], pack.manifest.slug);
    const sidebarBg = customTokens["sidebar_bg"];
    const activeRowBg = customTokens["active_row_bg"];
    const text = customTokens["text"];
    const subtext0 = customTokens["subtext0"];
    if (!sidebarBg || !activeRowBg || !text || !subtext0) {
      throw new Error(`"${slug}" wrote no sidebar_bg/active_row_bg/text/subtext0 tokens`);
    }
    return { sidebarBg, activeRowBg, text, subtext0 };
  }

  it("clears row-vs-sidebar visibility, text-on-row (4.5) and subtext0-on-row (3.0, never regressing CHM-50) together, for every bundled pack", () => {
    const packs = loadCuratedThemePacks();
    expect(packs.length).toBeGreaterThan(0);

    for (const pack of packs) {
      const { sidebarBg, activeRowBg, text, subtext0 } = activeRowTokensFor(pack.manifest.slug);

      expect(contrastRatio(activeRowBg, sidebarBg), `${pack.manifest.slug}: row-vs-sidebar`).toBeGreaterThanOrEqual(ACTIVE_ROW_MIN_VISIBLE_RATIO);
      expect(contrastRatio(text, activeRowBg), `${pack.manifest.slug}: text-on-row`).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
      expect(contrastRatio(subtext0, activeRowBg), `${pack.manifest.slug}: subtext0-on-row`).toBeGreaterThanOrEqual(MUTED_MIN_RATIO);
    }
  });

  // CHM-75's own target: subtext0-on-row reaches all the way to
  // TEXT_MIN_RATIO, not just MUTED_MIN_RATIO, for every bundled pack except
  // the three named below — reached for, never demanded, the same shape
  // SELECTION_IDEAL_RATIO already uses for the selection highlight (see
  // repairMutedForActiveRow's own doc comment in palette/surfaces.ts).
  // ayu-light, everforest-light and tokyo-night-light are the ones where
  // body itself has too little headroom over its own TEXT_MIN_RATIO floor
  // (6.12, 6.13 and 6.11 against ground) to leave subtext0 room to clear
  // TEXT_MIN_RATIO *and* stay measurably below it at once — CHM-30's own
  // kind of unreachable case, on this pair instead of selection-vs-ground.
  // CHM-80's lower row floor moved this set: dracula-dark and solarized-light
  // (CHM-75's own two named exceptions) now clear TEXT_MIN_RATIO outright
  // (6.79 and 4.51), and ayu-light newly falls short (4.47) where it used to
  // clear (4.59) — the row's own smaller lift leaves muted more room in
  // general, but ayu-light's own body-vs-ground headroom was already the
  // tightest of the four, so it is the one the trade lands on now. Each of
  // the three still lands within 0.06 of the target, not the ~0.2 gap
  // CHM-75 shipped. Known, bounded shortfalls are fixtures here, not
  // silently averaged away — see code-standards.md, "Colour tests use real
  // schemes' real values".
  const PACKS_BELOW_IDEAL_READABILITY = new Set(["ayu-light", "everforest-light", "tokyo-night-light"]);

  it("clears TEXT_MIN_RATIO for subtext0-on-row for every bundled pack outside the named exceptions", () => {
    const packs = loadCuratedThemePacks();
    for (const pack of packs) {
      if (PACKS_BELOW_IDEAL_READABILITY.has(pack.manifest.slug)) continue;
      const { activeRowBg, subtext0 } = activeRowTokensFor(pack.manifest.slug);
      expect(contrastRatio(subtext0, activeRowBg), pack.manifest.slug).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
    }
  });

  // CHM-80's own regression proof: the shipped monokai-dark value this
  // ticket exists to fix (4.63) scraped TEXT_MIN_RATIO rather than clearing
  // it with real margin. Asserted with a comfortable margin above the floor,
  // not just the floor itself, so a fix that merely nudges the old value
  // back to "technically legal" fails this test.
  it("clears TEXT_MIN_RATIO with a comfortable margin for monokai-dark, not by scraping it the way the shipped 4.63 did", () => {
    const oldShippedValue = 4.63;
    const comfortableMarginAboveFloor = 1;
    expect(oldShippedValue).toBeLessThan(TEXT_MIN_RATIO + comfortableMarginAboveFloor);

    const { activeRowBg, subtext0 } = activeRowTokensFor("monokai-dark");
    expect(contrastRatio(subtext0, activeRowBg)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO + comfortableMarginAboveFloor);
  });

  it("still lands within 0.06 of TEXT_MIN_RATIO for the three named exceptions", () => {
    for (const slug of PACKS_BELOW_IDEAL_READABILITY) {
      const { activeRowBg, subtext0 } = activeRowTokensFor(slug);
      const subtextOnRow = contrastRatio(subtext0, activeRowBg);
      expect(subtextOnRow, slug).toBeLessThan(TEXT_MIN_RATIO);
      expect(subtextOnRow, slug).toBeGreaterThan(TEXT_MIN_RATIO - 0.06);
    }
  });

  // CHM-75's other own guarantee: subtext0 stays measurably below text
  // against sidebar_bg, so it still reads as muted everywhere it is not the
  // one thing being read — for every bundled pack, no named exceptions.
  // Unlike TEXT_MIN_RATIO-on-row above, this one is never traded away: see
  // repairMutedForActiveRow's own doc comment for why its cap is measured
  // against text itself (what Herdr actually paints), not an intermediate
  // pre-repair value that would understate how much room text really has.
  it("keeps subtext0 measurably below text against sidebar_bg, for every bundled pack", () => {
    const packs = loadCuratedThemePacks();
    for (const pack of packs) {
      const { sidebarBg, text, subtext0 } = activeRowTokensFor(pack.manifest.slug);
      expect(contrastRatio(subtext0, sidebarBg), pack.manifest.slug).toBeLessThan(contrastRatio(text, sidebarBg));
    }
  });

  // Every bundled pack's own exact numbers — pinned so a future change that
  // narrows coverage back down, for any one pack, shows up as a specific
  // number moving rather than a boolean flipping. Extends CHM-50's own
  // four-pack spot check (dracula-dark, monokai-dark, night-owl-dark,
  // nord-dark) to the full set, since CHM-75 changed every one of these
  // three columns for the large majority of bundled packs — and CHM-80
  // changes rowVsSidebar and subtextOnRow again, for all 29, by retuning
  // ACTIVE_ROW_MIN_VISIBLE_RATIO and taking the smallest lift that clears
  // it rather than the largest subtext0 happened to tolerate.
  const NAMED_FIXTURES = [
    { slug: "ayu-dark-deep", rowVsSidebar: 1.3223, textOnRow: 7.7704, subtextOnRow: 5.1916 },
    { slug: "ayu-dark", rowVsSidebar: 1.3174, textOnRow: 7.1769, subtextOnRow: 4.8389 },
    { slug: "ayu-light", rowVsSidebar: 1.3143, textOnRow: 4.6559, subtextOnRow: 4.4703 },
    { slug: "catppuccin-dark", rowVsSidebar: 1.3181, textOnRow: 8.6044, subtextOnRow: 5.609 },
    { slug: "catppuccin-light", rowVsSidebar: 1.3206, textOnRow: 5.3475, subtextOnRow: 4.6702 },
    { slug: "dracula-dark", rowVsSidebar: 1.3186, textOnRow: 10.1316, subtextOnRow: 6.7937 },
    { slug: "everforest-dark", rowVsSidebar: 1.3196, textOnRow: 6.5306, subtextOnRow: 4.9075 },
    { slug: "everforest-light", rowVsSidebar: 1.314, textOnRow: 4.6645, subtextOnRow: 4.4495 },
    { slug: "github-dark", rowVsSidebar: 1.3268, textOnRow: 12.0711, subtextOnRow: 8.0924 },
    { slug: "github-light", rowVsSidebar: 2.0357, textOnRow: 7.7601, subtextOnRow: 5.0919 },
    { slug: "gruvbox-dark", rowVsSidebar: 1.3135, textOnRow: 8.1817, subtextOnRow: 5.3725 },
    { slug: "gruvbox-light", rowVsSidebar: 1.3203, textOnRow: 7.7408, subtextOnRow: 5.0923 },
    { slug: "jellybeans", rowVsSidebar: 1.3231, textOnRow: 10.5243, subtextOnRow: 7.5364 },
    { slug: "kanagawa-dark", rowVsSidebar: 1.3186, textOnRow: 8.5417, subtextOnRow: 5.6926 },
    { slug: "kanagawa-light", rowVsSidebar: 1.3145, textOnRow: 4.7056, subtextOnRow: 4.538 },
    { slug: "monokai-dark", rowVsSidebar: 1.313, textOnRow: 11.1859, subtextOnRow: 7.4873 },
    { slug: "night-owl-dark", rowVsSidebar: 1.3134, textOnRow: 10.3088, subtextOnRow: 6.8083 },
    { slug: "night-owl-light", rowVsSidebar: 1.3138, textOnRow: 7.7823, subtextOnRow: 5.1239 },
    { slug: "nord-dark", rowVsSidebar: 1.3161, textOnRow: 7.0248, subtextOnRow: 4.7055 },
    { slug: "nord-light", rowVsSidebar: 1.3211, textOnRow: 5.6938, subtextOnRow: 4.5859 },
    { slug: "one-half-dark", rowVsSidebar: 1.3235, textOnRow: 7.917, subtextOnRow: 5.2398 },
    { slug: "one-half-light", rowVsSidebar: 1.3129, textOnRow: 8.2744, subtextOnRow: 5.6736 },
    { slug: "rose-pine-dark", rowVsSidebar: 1.3129, textOnRow: 10.1983, subtextOnRow: 6.7798 },
    { slug: "rose-pine-light", rowVsSidebar: 1.3131, textOnRow: 5.0698, subtextOnRow: 4.7706 },
    { slug: "shades-of-purple", rowVsSidebar: 1.3148, textOnRow: 12.2391, subtextOnRow: 8.0148 },
    { slug: "solarized-dark", rowVsSidebar: 1.3178, textOnRow: 4.7195, subtextOnRow: 4.5131 },
    { slug: "solarized-light", rowVsSidebar: 1.3146, textOnRow: 4.7525, subtextOnRow: 4.5214 },
    { slug: "tokyo-night-dark", rowVsSidebar: 1.3244, textOnRow: 7.9938, subtextOnRow: 5.2486 },
    { slug: "tokyo-night-light", rowVsSidebar: 1.3198, textOnRow: 4.6331, subtextOnRow: 4.4552 },
  ];

  it.each(NAMED_FIXTURES)(
    "$slug: row-vs-sidebar $rowVsSidebar, text-on-row $textOnRow, subtext0-on-row $subtextOnRow",
    ({ slug, rowVsSidebar, textOnRow, subtextOnRow }) => {
      const { sidebarBg, activeRowBg, text, subtext0 } = activeRowTokensFor(slug);

      expect(contrastRatio(activeRowBg, sidebarBg)).toBeCloseTo(rowVsSidebar, 3);
      expect(contrastRatio(text, activeRowBg)).toBeCloseTo(textOnRow, 3);
      expect(contrastRatio(subtext0, activeRowBg)).toBeCloseTo(subtextOnRow, 3);
    },
  );

  it("never needed to trade row visibility away for readability on any bundled pack — see resolveActiveRowAndText's own retreat fallback", () => {
    // Positive evidence for CHM-33's own warning: rather than asserting an
    // impossibility band exists somewhere, this confirms none of the real 29
    // ever reaches resolveActiveRowAndText's retreat branch — the mechanism
    // exists for a pack this library does not ship, and is exercised
    // directly (with the retreat forced) in palette/surfaces.test.ts instead.
    const packs = loadCuratedThemePacks();
    for (const pack of packs) {
      const scheme = pack.payloads["windows-terminal"];
      const roleHexes = resolveRoleHexes(scheme);
      const { selection, body } = resolveSelectionAndBody(
        scheme.selectionBackground,
        roleHexes.ground,
        roleHexes.body,
        roleHexes.accent,
        [roleHexes.success, roleHexes.error],
      );
      const rowAndText = resolveActiveRowAndText(roleHexes.ground, body.hex, roleHexes.muted, [selection.hex], ACTIVE_ROW_IDEAL_FRACTION);
      expect(rowAndText.wasVisibilityTraded, pack.manifest.slug).toBe(false);
    }
  });
});

// CHM-78: CHM-75 raised subtext0's own floor against active_row_bg, on the
// theory that it was the token carrying the agent's own title and provider
// on a selected row. Probing Herdr directly (setting surface_dim, surface0,
// surface1, overlay0 and overlay1 to five distinct loud colours and
// reloading — see this ticket's own body and repairOverlay0 in
// palette/surfaces.ts) showed that surface never reads subtext0 at all:
// overlay0 paints both the sidebar's own section headers and every agent
// row's subtitle line, subtext0 renders nowhere in the sidebar, and
// surface_dim, surface0, surface1 and overlay1 carry no text either. These
// tests pin overlay0's own fix directly, the same shape as the CHM-50/CHM-75
// suite above but for the token Herdr actually paints text with.
describe("herdr adapter — overlay0 vs sidebar and active row (CHM-78)", () => {
  interface Overlay0Tokens {
    readonly sidebarBg: string;
    readonly activeRowBg: string;
    readonly overlay0: string;
  }

  function overlay0TokensFor(slug: string): Overlay0Tokens {
    const packs = loadCuratedThemePacks();
    const pack = packs.find((candidate) => candidate.manifest.slug === slug);
    if (!pack) throw new Error(`fixture pack not found: ${slug}`);

    const configDir = mkdtempSync(path.join(tmpdir(), "chameleon-herdr-overlay0-"));
    const configPath = path.join(configDir, "config.toml");
    writeFileSync(configPath, '[theme]\nname = "builtin"\n', "utf8");
    try {
      createHerdrAdapter(configPath).apply(pack.payloads["windows-terminal"], pack.manifest.slug);
      const customTokens = createHerdrAdapter(configPath).read().theme.custom;
      const sidebarBg = customTokens["sidebar_bg"];
      const activeRowBg = customTokens["active_row_bg"];
      const overlay0 = customTokens["overlay0"];
      if (!sidebarBg || !activeRowBg || !overlay0) {
        throw new Error(`"${slug}" wrote no sidebar_bg/active_row_bg/overlay0 tokens`);
      }
      return { sidebarBg, activeRowBg, overlay0 };
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  }

  it("clears TEXT_MIN_RATIO against both sidebar_bg and active_row_bg, for every bundled pack", () => {
    const packs = loadCuratedThemePacks();
    expect(packs.length).toBeGreaterThan(0);

    for (const pack of packs) {
      const { sidebarBg, activeRowBg, overlay0 } = overlay0TokensFor(pack.manifest.slug);
      expect(contrastRatio(overlay0, sidebarBg), `${pack.manifest.slug}: overlay0-vs-sidebar`).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
      expect(contrastRatio(overlay0, activeRowBg), `${pack.manifest.slug}: overlay0-vs-row`).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
    }
  });

  // Every bundled pack's own exact numbers — pinned the same way the
  // CHM-50/CHM-75/CHM-80 suite above pins text-on-row and subtext0-on-row, so
  // a future change that narrows coverage back down, for any one pack, shows
  // up as a specific number moving rather than a boolean flipping. Unlike
  // subtext0-on-row, no bundled pack falls short of TEXT_MIN_RATIO here —
  // overlay0's own repair has ground and body's full distance to work with,
  // never body's own narrower headroom over TEXT_MIN_RATIO. CHM-80 moves
  // both columns for every pack: overlay0 is repaired against active_row_bg
  // too (CHM-78), so a lower, closer-to-ground row changes the single
  // repaired value both pairs below measure.
  const NAMED_FIXTURES = [
    { slug: "ayu-dark-deep", overlay0VsSidebar: 6.2704, overlay0VsRow: 4.7422 },
    { slug: "ayu-dark", overlay0VsSidebar: 6.1991, overlay0VsRow: 4.7057 },
    { slug: "ayu-light", overlay0VsSidebar: 6.2784, overlay0VsRow: 4.777 },
    { slug: "catppuccin-dark", overlay0VsSidebar: 6.2528, overlay0VsRow: 4.7439 },
    { slug: "catppuccin-light", overlay0VsSidebar: 6.2987, overlay0VsRow: 4.7695 },
    { slug: "dracula-dark", overlay0VsSidebar: 6.7918, overlay0VsRow: 5.1509 },
    { slug: "everforest-dark", overlay0VsSidebar: 6.2796, overlay0VsRow: 4.7587 },
    { slug: "everforest-light", overlay0VsSidebar: 6.192, overlay0VsRow: 4.7125 },
    { slug: "github-dark", overlay0VsSidebar: 7.5198, overlay0VsRow: 5.6676 },
    { slug: "github-light", overlay0VsSidebar: 9.6061, overlay0VsRow: 4.7187 },
    { slug: "gruvbox-dark", overlay0VsSidebar: 6.25, overlay0VsRow: 4.7581 },
    { slug: "gruvbox-light", overlay0VsSidebar: 6.1455, overlay0VsRow: 4.6548 },
    { slug: "jellybeans", overlay0VsSidebar: 6.6575, overlay0VsRow: 5.0318 },
    { slug: "kanagawa-dark", overlay0VsSidebar: 6.2124, overlay0VsRow: 4.7112 },
    { slug: "kanagawa-light", overlay0VsSidebar: 6.211, overlay0VsRow: 4.7249 },
    { slug: "monokai-dark", overlay0VsSidebar: 7.3312, overlay0VsRow: 5.5837 },
    { slug: "night-owl-dark", overlay0VsSidebar: 6.4931, overlay0VsRow: 4.9438 },
    { slug: "night-owl-light", overlay0VsSidebar: 6.1724, overlay0VsRow: 4.6981 },
    { slug: "nord-dark", overlay0VsSidebar: 6.2037, overlay0VsRow: 4.7137 },
    { slug: "nord-light", overlay0VsSidebar: 6.2378, overlay0VsRow: 4.7216 },
    { slug: "one-half-dark", overlay0VsSidebar: 6.2247, overlay0VsRow: 4.7031 },
    { slug: "one-half-light", overlay0VsSidebar: 6.1969, overlay0VsRow: 4.72 },
    { slug: "rose-pine-dark", overlay0VsSidebar: 6.5818, overlay0VsRow: 5.0134 },
    { slug: "rose-pine-light", overlay0VsSidebar: 6.117, overlay0VsRow: 4.6584 },
    { slug: "shades-of-purple", overlay0VsSidebar: 7.8327, overlay0VsRow: 5.9572 },
    { slug: "solarized-dark", overlay0VsSidebar: 6.261, overlay0VsRow: 4.751 },
    { slug: "solarized-light", overlay0VsSidebar: 6.2439, overlay0VsRow: 4.7497 },
    { slug: "tokyo-night-dark", overlay0VsSidebar: 6.3153, overlay0VsRow: 4.7684 },
    { slug: "tokyo-night-light", overlay0VsSidebar: 6.1793, overlay0VsRow: 4.6821 },
  ];

  it.each(NAMED_FIXTURES)(
    "$slug: overlay0-vs-sidebar $overlay0VsSidebar, overlay0-vs-row $overlay0VsRow",
    ({ slug, overlay0VsSidebar, overlay0VsRow }) => {
      const { sidebarBg, activeRowBg, overlay0 } = overlay0TokensFor(slug);

      expect(contrastRatio(overlay0, sidebarBg)).toBeCloseTo(overlay0VsSidebar, 3);
      expect(contrastRatio(overlay0, activeRowBg)).toBeCloseTo(overlay0VsRow, 3);
    },
  );
});

// CHM-79: the declared contrast inventory (see palette/surfaces.ts's
// herdrContrastPairs), run against what this adapter actually writes to
// config.toml for every one of the 29 bundled packs — not a re-derivation,
// the real [theme.custom] table an applied pack leaves behind, the same way
// overlay0TokensFor above proves CHM-78's own fix against real output rather
// than a recomputed copy of it.
describe("herdr adapter — CHM-79's declared contrast inventory, every bundled pack", () => {
  function allCustomTokensFor(slug: string): HerdrTokenSet {
    const packs = loadCuratedThemePacks();
    const pack = packs.find((candidate) => candidate.manifest.slug === slug);
    if (!pack) throw new Error(`fixture pack not found: ${slug}`);

    const configDir = mkdtempSync(path.join(tmpdir(), "chameleon-herdr-inventory-"));
    const configPath = path.join(configDir, "config.toml");
    writeFileSync(configPath, '[theme]\nname = "builtin"\n', "utf8");
    try {
      createHerdrAdapter(configPath).apply(pack.payloads["windows-terminal"], pack.manifest.slug);
      return createHerdrAdapter(configPath).read().theme.custom as unknown as HerdrTokenSet;
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  }

  it("clears every declared pair for every one of the 29 bundled packs — the gate this ticket adds, run against real written output", () => {
    const packs = loadCuratedThemePacks();
    expect(packs.length).toBe(29);

    for (const pack of packs) {
      const tokens = allCustomTokensFor(pack.manifest.slug);
      const failures = checkContrastPairs(herdrContrastPairs(tokens));
      expect(failures, `${pack.manifest.slug}: ${failures.map((failure) => failure.pair.label).join(", ")}`).toEqual([]);
    }
  });
});

// CHM-22: Chameleon's marked block wrote `text` and `subtext0` a second time
// even when the user already had them further down [theme.custom]. TOML
// forbids a duplicate key in a table, so Herdr rejected the whole file and
// silently kept the previous config. These tests pin the fix: a pre-existing
// plain line for one of Chameleon's own tokens is updated in place — value
// changed, comments and position untouched — instead of getting a second
// copy inside the marker. The fixture's `text`/`subtext0` values are the
// real Solarized Dark hex values from the ticket's own reload-config output.
describe("herdr adapter — duplicate key dedup", () => {
  let configDir: string;
  let configPath: string;
  let fixture: string;

  beforeEach(() => {
    configDir = mkdtempSync(path.join(tmpdir(), "chameleon-herdr-dedup-"));
    configPath = path.join(configDir, "config.toml");
    fixture = readFileSync(DUPLICATE_KEY_FIXTURE_PATH, "utf8");
    writeFileSync(configPath, fixture, "utf8");
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it("updates a pre-existing role token's value in place instead of adding a second copy inside the marker", () => {
    expect(countOccurrences(fixture, "text = ")).toBe(1);
    expect(countOccurrences(fixture, "subtext0 = ")).toBe(1);

    createHerdrAdapter(configPath).apply(ZEROX96F_SCHEME, MAPPED_DARK_SLUG);
    const resultText = readFileSync(configPath, "utf8");

    const expectedColorTable = expectedHerdrRoleHexes(ZEROX96F_SCHEME);
    expect(countOccurrences(resultText, "text = ")).toBe(1);
    expect(countOccurrences(resultText, "subtext0 = ")).toBe(1);
    expect(resultText).toContain(`text = "${expectedColorTable.body}"`);
    expect(resultText).toContain(`subtext0 = "${expectedColorTable.muted}" # inline comment, do not lose me`);
    expect(resultText).not.toContain('text = "#586E75"');
    expect(resultText).not.toContain('subtext0 = "#657B83"');
  });

  it("preserves the user's comments on a role token it takes over, standalone and trailing alike", () => {
    createHerdrAdapter(configPath).apply(ZEROX96F_SCHEME, MAPPED_DARK_SLUG);

    const resultText = readFileSync(configPath, "utf8");
    expect(resultText).toContain("# Solarized base01 — picked this shade of grey myself, don't overwrite the comment");
    expect(resultText).toContain("# inline comment, do not lose me");
  });

  it("leaves a custom token Chameleon has no role for untouched and singular", () => {
    createHerdrAdapter(configPath).apply(ZEROX96F_SCHEME, MAPPED_DARK_SLUG);

    const resultText = readFileSync(configPath, "utf8");
    expect(countOccurrences(resultText, "tab_bg = ")).toBe(1);
    expect(resultText).toContain('tab_bg = "#001100"');
    expect(resultText).toContain("# tab_bg is one of Herdr's explicitly rejected keys, never Chameleon's — must survive untouched");
  });

  it("still writes the remaining role tokens inside the marker", () => {
    createHerdrAdapter(configPath).apply(ZEROX96F_SCHEME, MAPPED_DARK_SLUG);

    const config = createHerdrAdapter(configPath).read();
    const expectedColorTable = resolveRoleHexes(ZEROX96F_SCHEME);
    expect(config.theme.custom["sidebar_bg"]).toBe(expectedColorTable.ground);
    expect(config.theme.custom["accent"]).toBe(expectedColorTable.accent);
    expect(config.theme.custom["green"]).toBe(expectedColorTable.success);
    expect(config.theme.custom["red"]).toBe(expectedColorTable.error);
    // One marker pair per table Chameleon owns — [theme.custom] and [ui].
    expect(countOccurrences(readFileSync(configPath, "utf8"), "# ch:begin")).toBe(2);
  });

  it("stays idempotent — a second apply of the same pack still produces exactly one of each key", () => {
    const adapter = createHerdrAdapter(configPath);

    adapter.apply(ZEROX96F_SCHEME, MAPPED_DARK_SLUG);
    const afterFirstApply = readFileSync(configPath, "utf8");
    adapter.apply(ZEROX96F_SCHEME, MAPPED_DARK_SLUG);
    const afterSecondApply = readFileSync(configPath, "utf8");

    expect(afterSecondApply).toBe(afterFirstApply);
    expect(countOccurrences(afterSecondApply, "text = ")).toBe(1);
    expect(countOccurrences(afterSecondApply, "subtext0 = ")).toBe(1);
  });

  it("keeps updating the taken-over token in place across a later apply of a different pack", () => {
    const adapter = createHerdrAdapter(configPath);

    adapter.apply(ZEROX96F_SCHEME, MAPPED_DARK_SLUG);
    adapter.apply(AARDVARK_BLUE_SCHEME, OTHER_MAPPED_DARK_SLUG);

    const resultText = readFileSync(configPath, "utf8");
    const expectedColorTable = resolveRoleHexes(AARDVARK_BLUE_SCHEME);
    expect(countOccurrences(resultText, "text = ")).toBe(1);
    expect(resultText).toContain(`text = "${expectedColorTable.body}"`);
  });
});

// CHM-23: Chameleon set [theme.custom].accent — the token Herdr's own theme
// preview reads — but never [ui].accent, the key Herdr's docs name as
// "Accent color for highlights, borders, and navigation UI". Applying a
// theme left pane and sidebar borders on whatever colour the user (or
// Herdr's own default) had there before. These tests pin the fix: [ui]'s own
// accent is taken over in place, exactly like a pre-existing [theme.custom]
// token (CHM-22's fix, reused — see upsertMarkedTokens), and every other
// [ui] setting is left alone.
describe("herdr adapter — ui accent (CHM-23)", () => {
  let configDir: string;
  let configPath: string;
  let fixture: string;

  beforeEach(() => {
    configDir = mkdtempSync(path.join(tmpdir(), "chameleon-herdr-ui-accent-"));
    configPath = path.join(configDir, "config.toml");
    fixture = readFileSync(UI_ACCENT_FIXTURE_PATH, "utf8");
    writeFileSync(configPath, fixture, "utf8");
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it("updates the user's existing [ui] accent in place, to exactly one occurrence, rather than adding a second copy", () => {
    expect(countOccurrences(tableBodyText(fixture, LF, "ui"), "accent = ")).toBe(1);

    createHerdrAdapter(configPath).apply(ZEROX96F_SCHEME, MAPPED_DARK_SLUG);
    const resultText = readFileSync(configPath, "utf8");

    const expectedColorTable = resolveRoleHexes(ZEROX96F_SCHEME);
    const uiBody = tableBodyText(resultText, LF, "ui");
    expect(countOccurrences(uiBody, "accent = ")).toBe(1);
    expect(uiBody).toContain(`accent = "${expectedColorTable.accent}"`);
    expect(uiBody).not.toContain('accent = "#268BD2"');
  });

  it("preserves the user's own comments explaining their [ui] accent choice", () => {
    createHerdrAdapter(configPath).apply(ZEROX96F_SCHEME, MAPPED_DARK_SLUG);

    const resultText = readFileSync(configPath, "utf8");
    expect(resultText).toContain("# I tried the Monokai magenta this theme ships with and it looked wrong");
    expect(resultText).toContain("# against every dark background I use, so I've stuck with Solarized blue");
    expect(resultText).toContain("# here for years now — please don't touch this without asking me first.");
  });

  it("leaves [theme.custom]'s own accent — a different table's same-named key — untouched by the [ui] take-over", () => {
    createHerdrAdapter(configPath).apply(ZEROX96F_SCHEME, MAPPED_DARK_SLUG);

    const config = createHerdrAdapter(configPath).read();
    const expectedColorTable = resolveRoleHexes(ZEROX96F_SCHEME);
    expect(config.theme.custom["accent"]).toBe(expectedColorTable.accent);
    expect(config.ui.accent).toBe(expectedColorTable.accent);
  });

  it("leaves [ui]'s other settings untouched by the accent take-over", () => {
    createHerdrAdapter(configPath).apply(ZEROX96F_SCHEME, MAPPED_DARK_SLUG);

    const resultText = readFileSync(configPath, "utf8");
    expect(resultText).toContain("show_status_bar = true");
  });

  it("stays idempotent — a second apply produces exactly one [ui] accent key and the same file", () => {
    const adapter = createHerdrAdapter(configPath);

    adapter.apply(ZEROX96F_SCHEME, MAPPED_DARK_SLUG);
    const afterFirstApply = readFileSync(configPath, "utf8");
    adapter.apply(ZEROX96F_SCHEME, MAPPED_DARK_SLUG);
    const afterSecondApply = readFileSync(configPath, "utf8");

    expect(afterSecondApply).toBe(afterFirstApply);
    expect(countOccurrences(tableBodyText(afterSecondApply, LF, "ui"), "accent = ")).toBe(1);
  });

  it("ch undo restores the user's original [ui] accent, and its comments, byte-for-byte", () => {
    createHerdrAdapter(configPath).apply(ZEROX96F_SCHEME, MAPPED_DARK_SLUG);
    expect(readFileSync(configPath, "utf8")).not.toBe(fixture);

    undoHerdr(configPath);

    expect(readFileSync(configPath, "utf8")).toBe(fixture);
  });
});

describe("herdr adapter — reload", () => {
  beforeEach(() => {
    vi.mocked(spawnSync).mockReset();
  });

  it("reloads by calling the socket-based reload-config subcommand, never a bare launch", () => {
    vi.mocked(spawnSync).mockReturnValue(makeSpawnResult());

    createHerdrAdapter("unused/config.toml").reload();

    expect(spawnSync).toHaveBeenCalledWith("herdr", ["server", "reload-config"], expect.objectContaining({ encoding: "utf8" }));
  });

  it("does not override the environment — HERDR_ENV, if set, reaches Herdr's own guard unchanged", () => {
    vi.mocked(spawnSync).mockReturnValue(makeSpawnResult());

    createHerdrAdapter("unused/config.toml").reload();

    const options = vi.mocked(spawnSync).mock.calls[0]?.[2];
    expect(options).not.toHaveProperty("env");
  });

  it("succeeds silently when the server accepts the reload", () => {
    vi.mocked(spawnSync).mockReturnValue(makeSpawnResult({ status: 0 }));
    expect(() => createHerdrAdapter("unused/config.toml").reload()).not.toThrow();
  });

  // CHM-22's own regression: spawnSync ran the binary successfully (no
  // `error`), but Herdr's own CLI reported failure via a non-zero exit and a
  // JSON payload on stderr. Checking `error` alone reported this as a
  // successful reload. `server_not_running` is no longer this test's own
  // example — see the next test — so this uses an unrelated code to keep
  // exercising the same exit-status-plus-JSON-stderr path.
  it("treats a non-zero exit with no spawn error as a failed reload", () => {
    vi.mocked(spawnSync).mockReturnValue(
      makeSpawnResult({
        error: undefined,
        status: 1,
        stderr: '{"code":"config_rejected","message":"theme.custom.text is not a valid colour"}',
      }),
    );

    const adapter = createHerdrAdapter("unused/config.toml");
    expect(() => adapter.reload()).toThrow(/config_rejected/);
    expect(() => adapter.reload()).toThrow(/theme\.custom\.text is not a valid colour/);
  });

  // CHM-45: nothing had ever called reload() before this ticket, so this
  // case never had anywhere to surface. Now that `apply` always reloads,
  // "no Herdr running right now" must not turn a config that landed
  // correctly into a reported failure — the config is already right on disk
  // and Herdr will read it the next time it starts.
  it("reports, rather than throws, when Herdr's own CLI finds no server to reload", () => {
    vi.mocked(spawnSync).mockReturnValue(
      makeSpawnResult({
        error: undefined,
        status: 1,
        stderr: '{"code":"server_not_running","message":"no herdr server is listening on this socket"}',
      }),
    );

    const adapter = createHerdrAdapter("unused/config.toml");
    expect(adapter.reload()).toBe("Herdr is not running — nothing to reload");
  });

  it("surfaces the spawn error itself when the binary could not be started at all", () => {
    vi.mocked(spawnSync).mockReturnValue(makeSpawnResult({ error: new Error("ENOENT"), status: null }));

    const adapter = createHerdrAdapter("unused/config.toml");
    expect(() => adapter.reload()).toThrow(/ENOENT/);
  });

  it("falls back to the exit status when stderr carries no JSON Herdr error", () => {
    vi.mocked(spawnSync).mockReturnValue(makeSpawnResult({ status: 1, stderr: "something went wrong, no idea what" }));

    const adapter = createHerdrAdapter("unused/config.toml");
    expect(() => adapter.reload()).toThrow(/status 1/);
  });

  // CHM-22: a config.toml with a duplicate key makes `herdr server
  // reload-config` exit 0 while its own stdout JSON says
  // `"status":"failed"` and names the parse error — Herdr kept the previous
  // config rather than accept the broken one. Checking only the exit code
  // (what CHM-5 added) called this a successful reload. This is the exact
  // payload from the ticket's own repro.
  it("treats a zero exit whose JSON payload reports status failed as a failed reload, surfacing Herdr's diagnostics verbatim", () => {
    vi.mocked(spawnSync).mockReturnValue(
      makeSpawnResult({
        status: 0,
        stdout: JSON.stringify({
          result: {
            diagnostics: [
              'config parse error: TOML parse error at line 23, column 1\n   |\n23 | text = "#586E75"\n   | ^\nduplicate key `text` in table `theme.custom`\n; keeping current config',
            ],
            status: "failed",
            type: "config_reload",
          },
        }),
      }),
    );

    const adapter = createHerdrAdapter("unused/config.toml");
    expect(() => adapter.reload()).toThrow(/duplicate key `text` in table `theme\.custom`/);
  });

  // CHM-28: an unknown [theme].name must be treated as a failure, not a
  // silent fallback — Herdr's own repro for this is
  // `theme.name = "definitely-not-a-theme"; using "catppuccin"`, reported
  // with "status":"partial" rather than "failed". This pins that CHM-22's
  // status check (which only special-cased "applied" as success) already
  // catches "partial" too, since it is simply not "applied" — no separate
  // handling needed.
  it("treats a zero exit whose JSON payload reports status partial as a failed reload, for an unknown theme name", () => {
    vi.mocked(spawnSync).mockReturnValue(
      makeSpawnResult({
        status: 0,
        stdout: JSON.stringify({
          result: {
            diagnostics: ['unknown theme name theme.name = "definitely-not-a-theme"; using "catppuccin"'],
            status: "partial",
            type: "config_reload",
          },
        }),
      }),
    );

    const adapter = createHerdrAdapter("unused/config.toml");
    expect(() => adapter.reload()).toThrow(/unknown theme name/);
  });

  it("succeeds when the JSON payload confirms status applied with empty diagnostics", () => {
    vi.mocked(spawnSync).mockReturnValue(
      makeSpawnResult({
        status: 0,
        stdout: JSON.stringify({ result: { diagnostics: [], status: "applied", type: "config_reload" } }),
      }),
    );

    expect(() => createHerdrAdapter("unused/config.toml").reload()).not.toThrow();
  });

  it("still succeeds on a zero exit with no JSON on stdout at all — an older Herdr that never sent this payload", () => {
    vi.mocked(spawnSync).mockReturnValue(makeSpawnResult({ status: 0, stdout: "" }));

    expect(() => createHerdrAdapter("unused/config.toml").reload()).not.toThrow();
  });
});
