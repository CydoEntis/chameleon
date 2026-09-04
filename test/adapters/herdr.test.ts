import type { SpawnSyncReturns } from "node:child_process";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHerdrAdapter, undoHerdr } from "../../src/adapters/herdr.js";
import { resolveRoleHexes } from "../../src/palette/repair.js";
import { parseScheme, type Scheme } from "../../src/palette/scheme.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(currentDir, "fixtures", "herdr-config.toml");

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

/** Herdr's own [theme.custom] token names for Chameleon's six roles, in role order — see ROLE_TO_HERDR_TOKEN in adapters/herdr.ts. */
const HERDR_TOKENS_IN_ROLE_ORDER = ["sidebar_bg", "text", "accent", "subtext0", "green", "red"];

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

  it("leaves [ui] and its comments byte-identical", () => {
    createHerdrAdapter(configPath).apply(ZEROX96F_SCHEME, MAPPED_DARK_SLUG);

    const resultText = readFileSync(configPath, "utf8");
    expect(resultText).toContain("# status bar lives here, out of scope for Chameleon");
    expect(resultText).toContain('pane_border_style = "rounded" # I like rounded borders');
    expect(resultText).toContain("show_status_bar = true");
    expect(resultText).toContain('socket_path = "/tmp/herdr.sock"');
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
    expect(countOccurrences(afterSecondApply, "# ch:begin")).toBe(1);
  });

  it("upserts the marked block in place when a different pack is applied later, instead of accumulating", () => {
    const adapter = createHerdrAdapter(configPath);

    adapter.apply(ZEROX96F_SCHEME, MAPPED_DARK_SLUG);
    adapter.apply(AARDVARK_BLUE_SCHEME, OTHER_MAPPED_DARK_SLUG);

    const resultText = readFileSync(configPath, "utf8");
    expect(countOccurrences(resultText, "# ch:begin")).toBe(1);
    expect(countOccurrences(resultText, "# ch:end")).toBe(1);
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

  it("falls back to Herdr's neutral dark built-in for a dark pack with no family match, and still carries its own colours", () => {
    createHerdrAdapter(configPath).apply(AARDVARK_BLUE_SCHEME, UNMAPPED_DARK_SLUG);

    const config = createHerdrAdapter(configPath).read();
    expect(config.theme.name).toBe("terminal");

    const expectedColorTable = resolveRoleHexes(AARDVARK_BLUE_SCHEME);
    expect(config.theme.custom["sidebar_bg"]).toBe(expectedColorTable.ground);
    expect(config.theme.custom["text"]).toBe(expectedColorTable.body);
    expect(config.theme.custom["accent"]).toBe(expectedColorTable.accent);
    expect(config.theme.custom["subtext0"]).toBe(expectedColorTable.muted);
    expect(config.theme.custom["green"]).toBe(expectedColorTable.success);
    expect(config.theme.custom["red"]).toBe(expectedColorTable.error);
  });

  it("falls back to a light built-in for a light pack with no family match", () => {
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

  // The regression this ticket exists to fix: spawnSync ran the binary
  // successfully (no `error`), but Herdr's own CLI reported failure via a
  // non-zero exit and a JSON payload on stderr. Checking `error` alone
  // reported this as a successful reload.
  it("treats a non-zero exit with no spawn error as a failed reload — the server_not_running case", () => {
    vi.mocked(spawnSync).mockReturnValue(
      makeSpawnResult({
        error: undefined,
        status: 1,
        stderr: '{"code":"server_not_running","message":"no herdr server is listening on this socket"}',
      }),
    );

    const adapter = createHerdrAdapter("unused/config.toml");
    expect(() => adapter.reload()).toThrow(/server_not_running/);
    expect(() => adapter.reload()).toThrow(/no herdr server is listening on this socket/);
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
});
