import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOhMyPoshAdapter, undoOhMyPosh } from "../../src/adapters/oh-my-posh.js";
import { ROLES } from "../../src/constants.js";
import { parseScheme, type Scheme } from "../../src/palette/scheme.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FIXTURE_PATH = path.join(currentDir, "fixtures", "oh-my-posh-config.omp.json");
const PROFILE_FIXTURE_PATH = path.join(currentDir, "fixtures", "profile.ps1");

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
 * Used for both the config and the profile: neither test hardcodes a
 * multi-line literal with a specific line ending, so the same check works
 * regardless of which of CRLF or LF the fixture under test uses.
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
 * The config fixture's lines minus its original "palette": { … } block —
 * the one thing an apply must replace. Everything else, `blocks` included,
 * must round-trip untouched.
 */
function configLinesUnrelatedToChameleonEdits(text: string, eol: string): string {
  const lines = text.split(eol);
  const kept: string[] = [];
  let isInsideOriginalPalette = false;
  for (const line of lines) {
    if (/^\s*"palette":\s*\{/.test(line)) {
      isInsideOriginalPalette = true;
      continue;
    }
    if (isInsideOriginalPalette) {
      if (/^\s*\},?\s*$/.test(line)) isInsideOriginalPalette = false;
      continue;
    }
    kept.push(line);
  }
  return kept.join(eol);
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function usesOnlyLineEnding(text: string, eol: string): boolean {
  return eol === CRLF ? !/(?<!\r)\n/.test(text) : !text.includes("\r");
}

function parseWritten(text: string): unknown {
  return parseJsonc(text, [], { allowTrailingComma: true });
}

// Both fixtures carry \n only in the repo (see .gitattributes, which pins
// them there regardless of core.autocrlf) — both line-ending variants are
// derived from them here so the test never depends on how git or the
// filesystem happened to check the files out. This is the exact bug CHM-4
// shipped: a fixture asserted against with a hardcoded line ending, pinned
// nowhere, that only matched in the worktree that wrote it.
const LF_CONFIG_FIXTURE = readFileSync(CONFIG_FIXTURE_PATH, "utf8").replace(/\r\n/g, LF);
const CRLF_CONFIG_FIXTURE = LF_CONFIG_FIXTURE.replace(/\n/g, CRLF);
const LF_PROFILE_FIXTURE = readFileSync(PROFILE_FIXTURE_PATH, "utf8").replace(/\r\n/g, LF);
const CRLF_PROFILE_FIXTURE = LF_PROFILE_FIXTURE.replace(/\n/g, CRLF);

describe.each([
  { label: "CRLF", configFixture: CRLF_CONFIG_FIXTURE, profileFixture: CRLF_PROFILE_FIXTURE, eol: CRLF },
  { label: "LF", configFixture: LF_CONFIG_FIXTURE, profileFixture: LF_PROFILE_FIXTURE, eol: LF },
])("oh my posh adapter — $label fixtures", ({ configFixture, profileFixture, eol }) => {
  let stateDir: string;
  let configPath: string;
  let profilePath: string;
  let pointerPath: string;

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(tmpdir(), "chameleon-oh-my-posh-"));
    configPath = path.join(stateDir, "theme.omp.json");
    profilePath = path.join(stateDir, "Microsoft.PowerShell_profile.ps1");
    pointerPath = path.join(stateDir, "oh-my-posh-pointer.json");
    writeFileSync(configPath, configFixture, "utf8");
    writeFileSync(profilePath, profileFixture, "utf8");
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("detects Oh My Posh by an existing config at the given path", () => {
    expect(createOhMyPoshAdapter(configPath, profilePath, pointerPath).detect()).toBe(true);
    expect(createOhMyPoshAdapter(undefined, profilePath, pointerPath).detect()).toBe(false);
    expect(createOhMyPoshAdapter(path.join(stateDir, "missing.omp.json"), profilePath, pointerPath).detect()).toBe(false);
  });

  it("reads a hostile config — comments and trailing commas included", () => {
    const config = createOhMyPoshAdapter(configPath, profilePath, pointerPath).read();
    expect(config.palette?.["accent"]).toBe("#89b4fa");
    expect(Array.isArray(config.blocks)).toBe(true);
    expect(config["final_space"]).toBe(true);
  });

  it("round-trips every config line byte-identical outside the palette block, its own line endings included", () => {
    createOhMyPoshAdapter(configPath, profilePath, pointerPath).apply(ZEROX96F_SCHEME);

    const resultText = readFileSync(configPath, "utf8");
    expect(everyOriginalLineSurvivesInOrder(configLinesUnrelatedToChameleonEdits(configFixture, eol), resultText)).toBe(true);
    expect(usesOnlyLineEnding(resultText, eol)).toBe(true);
  });

  it("leaves the segment list byte-identical when swapping themes", () => {
    const adapter = createOhMyPoshAdapter(configPath, profilePath, pointerPath);
    const originalBlocks = (parseWritten(configFixture) as { blocks: unknown }).blocks;

    adapter.apply(ZEROX96F_SCHEME);
    adapter.apply(AARDVARK_BLUE_SCHEME);

    const resultBlocks = (parseWritten(readFileSync(configPath, "utf8")) as { blocks: unknown }).blocks;
    expect(resultBlocks).toEqual(originalBlocks);
  });

  it("leaves exactly one palette key, with every Chameleon role resolved to a hex colour", () => {
    createOhMyPoshAdapter(configPath, profilePath, pointerPath).apply(ZEROX96F_SCHEME);

    const resultText = readFileSync(configPath, "utf8");
    expect(countOccurrences(resultText, '"palette"')).toBe(1);
    const parsed = parseWritten(resultText) as { palette: Record<string, string> };
    for (const role of ROLES) {
      expect(parsed.palette[role]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("preserves unrelated comments and settings untouched by any edit", () => {
    createOhMyPoshAdapter(configPath, profilePath, pointerPath).apply(ZEROX96F_SCHEME);

    const resultText = readFileSync(configPath, "utf8");
    expect(resultText).toContain("// Oh My Posh config");
    expect(resultText).toContain("// keep the transient prompt on");
    expect(resultText).toContain('"console_title_template": "{{ .Shell }}"');

    const parsed = parseWritten(resultText) as Record<string, unknown>;
    expect(parsed["final_space"]).toBe(true);
  });

  it("is idempotent — applying the same theme twice produces the same config", () => {
    const adapter = createOhMyPoshAdapter(configPath, profilePath, pointerPath);

    adapter.apply(ZEROX96F_SCHEME);
    const afterFirstApply = readFileSync(configPath, "utf8");
    adapter.apply(ZEROX96F_SCHEME);
    const afterSecondApply = readFileSync(configPath, "utf8");

    expect(afterSecondApply).toBe(afterFirstApply);
    expect(countOccurrences(afterSecondApply, "// ch:begin")).toBe(1);
  });

  it("writes a backup of the config before every apply, and undo restores it exactly", () => {
    createOhMyPoshAdapter(configPath, profilePath, pointerPath).apply(ZEROX96F_SCHEME);
    expect(readFileSync(configPath, "utf8")).not.toBe(configFixture);
    expect(readFileSync(`${configPath}.chameleon-backup`, "utf8")).toBe(configFixture);

    undoOhMyPosh(configPath, profilePath);
    expect(readFileSync(configPath, "utf8")).toBe(configFixture);
  });

  it("reloads without touching the config or profile — the Set-PoshContext hook is what repaints, not this process", () => {
    createOhMyPoshAdapter(configPath, profilePath, pointerPath).reload();
    expect(readFileSync(configPath, "utf8")).toBe(configFixture);
    expect(readFileSync(profilePath, "utf8")).toBe(profileFixture);
  });

  describe("the Set-PoshContext hook", () => {
    it("chains the user's own Set-PoshContext instead of clobbering it", () => {
      createOhMyPoshAdapter(configPath, profilePath, pointerPath).apply(ZEROX96F_SCHEME);

      const resultText = readFileSync(profilePath, "utf8");
      // The user's own function is never edited in place — it is captured
      // at runtime via ${function:Set-PoshContext} before Chameleon's own
      // block redefines the name — so every original line, including the
      // user's Set-PoshContext body, survives verbatim.
      expect(everyOriginalLineSurvivesInOrder(profileFixture, resultText)).toBe(true);
      expect(resultText).toContain("$ChameleonPreviousSetPoshContext");
      expect(resultText).toContain("& $ChameleonPreviousSetPoshContext");
      expect(usesOnlyLineEnding(resultText, eol)).toBe(true);
    });

    it("is marker-scoped, backed up, and undoable", () => {
      const adapter = createOhMyPoshAdapter(configPath, profilePath, pointerPath);
      adapter.apply(ZEROX96F_SCHEME);

      const resultText = readFileSync(profilePath, "utf8");
      expect(countOccurrences(resultText, "# ch:begin")).toBe(1);
      expect(countOccurrences(resultText, "# ch:end")).toBe(1);
      expect(readFileSync(`${profilePath}.chameleon-backup`, "utf8")).toBe(profileFixture);

      undoOhMyPosh(configPath, profilePath);
      expect(readFileSync(profilePath, "utf8")).toBe(profileFixture);
    });

    it("upserts in place on a second apply — one hook, never accumulating", () => {
      const adapter = createOhMyPoshAdapter(configPath, profilePath, pointerPath);
      adapter.apply(ZEROX96F_SCHEME);
      adapter.apply(AARDVARK_BLUE_SCHEME);

      const resultText = readFileSync(profilePath, "utf8");
      expect(countOccurrences(resultText, "# ch:begin")).toBe(1);
      expect(everyOriginalLineSurvivesInOrder(profileFixture, resultText)).toBe(true);
    });
  });

  describe("the pointer file", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("records the active config path and a timestamp that moves on every apply", () => {
      const adapter = createOhMyPoshAdapter(configPath, profilePath, pointerPath);

      vi.setSystemTime(1_000);
      adapter.apply(ZEROX96F_SCHEME);
      const firstPointer = JSON.parse(readFileSync(pointerPath, "utf8")) as { configPath: string; updatedAtMs: number };
      expect(firstPointer.configPath).toBe(configPath);
      expect(firstPointer.updatedAtMs).toBe(1_000);

      vi.setSystemTime(2_000);
      adapter.apply(AARDVARK_BLUE_SCHEME);
      const secondPointer = JSON.parse(readFileSync(pointerPath, "utf8")) as { configPath: string; updatedAtMs: number };
      expect(secondPointer.updatedAtMs).toBe(2_000);
      expect(secondPointer.updatedAtMs).toBeGreaterThan(firstPointer.updatedAtMs);
    });
  });
});

describe("oh my posh adapter — edge cases", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(tmpdir(), "chameleon-oh-my-posh-edge-"));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("names the file and the problem when a config it must edit is shaped wrong", () => {
    const malformedPath = path.join(stateDir, "malformed.omp.json");
    writeFileSync(malformedPath, JSON.stringify({ palette: "not an object" }), "utf8");
    expect(() => createOhMyPoshAdapter(malformedPath, path.join(stateDir, "profile.ps1"), path.join(stateDir, "pointer.json")).read()).toThrow(
      malformedPath,
    );
  });

  it("refuses to apply when POSH_THEME names no config", () => {
    const adapter = createOhMyPoshAdapter(undefined, path.join(stateDir, "profile.ps1"), path.join(stateDir, "pointer.json"));
    expect(() => adapter.apply(ZEROX96F_SCHEME)).toThrow(/POSH_THEME/);
  });

  it("refuses to apply when there is no config at the given path", () => {
    const adapter = createOhMyPoshAdapter(
      path.join(stateDir, "missing.omp.json"),
      path.join(stateDir, "profile.ps1"),
      path.join(stateDir, "pointer.json"),
    );
    expect(() => adapter.apply(ZEROX96F_SCHEME)).toThrow();
  });

  it("creates the profile when none exists yet, rather than failing", () => {
    const configPath = path.join(stateDir, "theme.omp.json");
    writeFileSync(configPath, JSON.stringify({ blocks: [] }), "utf8");
    const profilePath = path.join(stateDir, "nested", "Microsoft.PowerShell_profile.ps1");
    const pointerPath = path.join(stateDir, "pointer.json");

    createOhMyPoshAdapter(configPath, profilePath, pointerPath).apply(ZEROX96F_SCHEME);

    const resultText = readFileSync(profilePath, "utf8");
    expect(resultText).toContain("function Set-PoshContext");
    expect(resultText).not.toMatch(/,\s*[\]}]/);
  });

  it("never leaves a dangling comma when palette starts out missing entirely", () => {
    const configPath = path.join(stateDir, "theme.omp.json");
    writeFileSync(configPath, JSON.stringify({ blocks: [] }), "utf8");
    const profilePath = path.join(stateDir, "profile.ps1");
    const pointerPath = path.join(stateDir, "pointer.json");

    createOhMyPoshAdapter(configPath, profilePath, pointerPath).apply(ZEROX96F_SCHEME);

    const resultText = readFileSync(configPath, "utf8");
    const parsed = parseWritten(resultText) as { palette: Record<string, string> };
    expect(parsed.palette["accent"]).toMatch(/^#[0-9a-f]{6}$/i);
    expect(resultText).not.toMatch(/,\s*[\]}]/);
  });
});
