import type { SpawnSyncReturns } from "node:child_process";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHerdrAdapter, undoHerdr } from "../../src/adapters/herdr.js";
import { ROLES } from "../../src/constants.js";
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
    createHerdrAdapter(configPath).apply(ZEROX96F_SCHEME);

    const resultText = readFileSync(configPath, "utf8");
    expect(everyOriginalLineSurvivesInOrder(linesUnrelatedToChameleonEdits(fixture, eol), resultText)).toBe(true);
    expect(usesOnlyLineEnding(resultText, eol)).toBe(true);
  });

  it("leaves [ui] and its comments byte-identical", () => {
    createHerdrAdapter(configPath).apply(ZEROX96F_SCHEME);

    const resultText = readFileSync(configPath, "utf8");
    expect(resultText).toContain("# status bar lives here, out of scope for Chameleon");
    expect(resultText).toContain('pane_border_style = "rounded" # I like rounded borders');
    expect(resultText).toContain("show_status_bar = true");
    expect(resultText).toContain('socket_path = "/tmp/herdr.sock"');
  });

  it("leaves exactly one name key, resolving to the applied scheme's name", () => {
    expect(fixture).toContain('name = "legacy-theme"');

    createHerdrAdapter(configPath).apply(ZEROX96F_SCHEME);

    const resultText = readFileSync(configPath, "utf8");
    expect(countOccurrences(resultText, "name = ")).toBe(1);
    expect(resultText).toContain('name = "0x96f"');
  });

  it("keeps a user's own [theme.custom] overrides untouched, alongside Chameleon's own tokens", () => {
    createHerdrAdapter(configPath).apply(ZEROX96F_SCHEME);

    const resultText = readFileSync(configPath, "utf8");
    expect(resultText).toContain("# my own overrides, do not remove");
    expect(resultText).toContain('banner = "#112233"');
    expect(resultText).toContain('accent_override = "#445566"');

    const config = createHerdrAdapter(configPath).read();
    for (const role of ROLES) {
      expect(config.theme.custom[role]).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(config.theme.custom["banner"]).toBe("#112233");
    expect(config.theme.custom["accent_override"]).toBe("#445566");
  });

  it("is idempotent — applying the same theme twice produces the same file", () => {
    const adapter = createHerdrAdapter(configPath);

    adapter.apply(ZEROX96F_SCHEME);
    const afterFirstApply = readFileSync(configPath, "utf8");
    adapter.apply(ZEROX96F_SCHEME);
    const afterSecondApply = readFileSync(configPath, "utf8");

    expect(afterSecondApply).toBe(afterFirstApply);
    expect(countOccurrences(afterSecondApply, "# ch:begin")).toBe(1);
  });

  it("upserts the marked block in place when a different theme is applied later, instead of accumulating", () => {
    const adapter = createHerdrAdapter(configPath);

    adapter.apply(ZEROX96F_SCHEME);
    adapter.apply(AARDVARK_BLUE_SCHEME);

    const resultText = readFileSync(configPath, "utf8");
    expect(countOccurrences(resultText, "# ch:begin")).toBe(1);
    expect(countOccurrences(resultText, "# ch:end")).toBe(1);
    expect(resultText).toContain('name = "Aardvark Blue"');
    // The user's own overrides are still there, untouched by the second apply.
    expect(resultText).toContain('banner = "#112233"');
  });

  it("writes a backup before every apply, and undo restores it exactly", () => {
    createHerdrAdapter(configPath).apply(ZEROX96F_SCHEME);
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
    expect(() => adapter.apply(ZEROX96F_SCHEME)).toThrow();
  });

  it("creates [theme.custom] when the config does not have one yet", () => {
    const configPath = path.join(configDir, "config.toml");
    writeFileSync(configPath, '[theme]\nname = "builtin"\n', "utf8");

    createHerdrAdapter(configPath).apply(ZEROX96F_SCHEME);

    const config = createHerdrAdapter(configPath).read();
    for (const role of ROLES) {
      expect(config.theme.custom[role]).toMatch(/^#[0-9a-f]{6}$/i);
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
