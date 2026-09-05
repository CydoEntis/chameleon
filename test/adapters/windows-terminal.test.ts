import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createWindowsTerminalAdapter,
  selectedFontFace,
  selectWindowsTerminalFont,
  undoWindowsTerminal,
  windowsTerminalMatchesScheme,
} from "../../src/adapters/windows-terminal.js";
import { parseScheme, type Scheme } from "../../src/palette/scheme.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(currentDir, "fixtures", "settings.jsonc");

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
 * This is the byte-for-byte-outside-the-markers guarantee, checked without
 * re-implementing the adapter's own splicing logic inside the test.
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
 * The fixture's lines minus the two Chameleon is fixing this ticket to
 * *replace* — the pre-existing "theme" and "colorScheme" — leaving only
 * what an apply must round-trip untouched. Asserting the replaced lines
 * themselves survive would be asserting the pre-existing-key bug is still
 * there; see the "leaves exactly one …" tests for what happens to them.
 */
function linesUnrelatedToChameleonEdits(text: string, eol: string): string {
  return text
    .split(eol)
    .filter((line) => !/^\s*"(theme|colorScheme)":/.test(line))
    .join(eol);
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/**
 * True when every line break in `text` is `eol` — no stray "\n" among
 * "\r\n"s, and no stray "\r" left over when `eol` is bare "\n". A blanket
 * "does the other line ending appear anywhere" check would pass vacuously
 * for the LF case, since stripping every "\n" first would also remove any
 * "\r\n" it was part of — this checks each line break directly instead.
 */
function usesOnlyLineEnding(text: string, eol: string): boolean {
  return eol === CRLF ? !/(?<!\r)\n/.test(text) : !text.includes("\r");
}

function parseWritten(text: string): unknown {
  return parseJsonc(text, [], { allowTrailingComma: true });
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
])("windows terminal adapter — $label fixture", ({ fixture, eol }) => {
  let settingsDir: string;
  let settingsPath: string;

  beforeEach(() => {
    settingsDir = mkdtempSync(path.join(tmpdir(), "chameleon-windows-terminal-"));
    settingsPath = path.join(settingsDir, "settings.json");
    writeFileSync(settingsPath, fixture, "utf8");
  });

  afterEach(() => {
    rmSync(settingsDir, { recursive: true, force: true });
  });

  it("detects Windows Terminal by the presence of its settings.json", () => {
    expect(createWindowsTerminalAdapter(settingsPath).detect()).toBe(true);
    expect(createWindowsTerminalAdapter(path.join(settingsDir, "missing.json")).detect()).toBe(false);
  });

  it("reads a hostile settings.json — comments and trailing commas included", () => {
    const settings = createWindowsTerminalAdapter(settingsPath).read();
    expect(settings["copyOnSelect"]).toBe(false);
    expect(Array.isArray(settings.schemes)).toBe(true);
    expect(settings.profiles?.defaults?.["fontFace"]).toBe("Cascadia Mono");
  });

  it("round-trips every original line byte-identical, its own line endings included", () => {
    createWindowsTerminalAdapter(settingsPath).apply(ZEROX96F_SCHEME);

    const resultText = readFileSync(settingsPath, "utf8");
    expect(everyOriginalLineSurvivesInOrder(linesUnrelatedToChameleonEdits(fixture, eol), resultText)).toBe(true);

    // Every line ending in the file — original lines and the newly inserted
    // block alike — matches the fixture's own. A stray "\n" among "\r\n"s
    // (or vice-versa) is exactly the CHM-3 defect this rewrite fixes.
    expect(usesOnlyLineEnding(resultText, eol)).toBe(true);
  });

  it("leaves exactly one theme key, resolving to Chameleon's value, when one already existed", () => {
    expect(fixture).toContain('"theme": "legacy"');

    createWindowsTerminalAdapter(settingsPath).apply(ZEROX96F_SCHEME);

    const resultText = readFileSync(settingsPath, "utf8");
    expect(countOccurrences(resultText, '"theme"')).toBe(1);
    const parsed = parseWritten(resultText) as { theme?: unknown };
    expect(parsed.theme).toBe("dark"); // 0x96f's background (#262427) is dark
  });

  it("leaves exactly one profiles.defaults.colorScheme key, resolving to Chameleon's value, when one already existed", () => {
    expect(fixture).toContain('"colorScheme": "Campbell"');

    createWindowsTerminalAdapter(settingsPath).apply(ZEROX96F_SCHEME);

    const resultText = readFileSync(settingsPath, "utf8");
    expect(countOccurrences(resultText, '"colorScheme"')).toBe(1);
    const parsed = parseWritten(resultText) as { profiles?: { defaults?: { colorScheme?: unknown } } };
    expect(parsed.profiles?.defaults?.colorScheme).toBe("0x96f");
  });

  it("preserves unrelated comments, key order and settings untouched by any edit", () => {
    createWindowsTerminalAdapter(settingsPath).apply(ZEROX96F_SCHEME);

    const resultText = readFileSync(settingsPath, "utf8");
    expect(resultText).toContain("// Windows Terminal user configuration");
    expect(resultText).toContain('"name": "Campbell"');
    expect(resultText).toContain('"fontFace": "Cascadia Mono"');
    expect(resultText).toContain("// keep the tab bar out of the way");
    expect(resultText).toContain("// I like this off");

    const parsed = parseWritten(resultText) as Record<string, unknown>;
    expect(parsed["alwaysShowTabs"]).toBe(true);
  });

  it("is idempotent — applying the same theme twice produces the same file, and does not duplicate its schemes[] entry", () => {
    const adapter = createWindowsTerminalAdapter(settingsPath);

    adapter.apply(ZEROX96F_SCHEME);
    const afterFirstApply = readFileSync(settingsPath, "utf8");

    adapter.apply(ZEROX96F_SCHEME);
    const afterSecondApply = readFileSync(settingsPath, "utf8");

    expect(afterSecondApply).toBe(afterFirstApply);
    // "0x96f" is already in schemes[] after the first apply — re-applying it
    // must not add a second entry under the same name.
    const parsed = parseWritten(afterSecondApply) as { schemes: Array<{ name: string }> };
    expect(parsed.schemes.filter((s) => s.name === "0x96f")).toHaveLength(1);
  });

  it("upserts in place when a different theme is applied later, instead of accumulating marked blocks", () => {
    const adapter = createWindowsTerminalAdapter(settingsPath);

    adapter.apply(ZEROX96F_SCHEME);
    adapter.apply(AARDVARK_BLUE_SCHEME);

    const resultText = readFileSync(settingsPath, "utf8");
    const parsed = parseWritten(resultText) as {
      theme?: unknown;
      profiles: { defaults: { colorScheme?: unknown } };
      schemes: Array<{ name: string }>;
    };
    expect(parsed.profiles.defaults.colorScheme).toBe("Aardvark Blue");
    expect(parsed.schemes.filter((s) => s.name === "Aardvark Blue")).toHaveLength(1);
    expect(parsed.schemes.filter((s) => s.name === "0x96f")).toHaveLength(0); // replaced, not accumulated
    expect(parsed.schemes.some((s) => s.name === "Campbell")).toBe(true); // truly unrelated, still there
    // One marked block each for schemes, profiles.defaults and the top-level theme — never more.
    expect(countOccurrences(resultText, "// ch:begin")).toBe(3);
  });

  it("writes a backup before every apply, and undo restores it exactly", () => {
    createWindowsTerminalAdapter(settingsPath).apply(ZEROX96F_SCHEME);
    expect(readFileSync(settingsPath, "utf8")).not.toBe(fixture);
    expect(readFileSync(`${settingsPath}.chameleon-backup`, "utf8")).toBe(fixture);

    undoWindowsTerminal(settingsPath);
    expect(readFileSync(settingsPath, "utf8")).toBe(fixture);
  });
});

describe("windows terminal adapter — edge cases", () => {
  let settingsDir: string;

  beforeEach(() => {
    settingsDir = mkdtempSync(path.join(tmpdir(), "chameleon-windows-terminal-edge-"));
  });

  afterEach(() => {
    rmSync(settingsDir, { recursive: true, force: true });
  });

  it("names the file and the problem when a config it must edit is shaped wrong", () => {
    const malformedPath = path.join(settingsDir, "malformed.json");
    writeFileSync(malformedPath, JSON.stringify({ profiles: "not an object" }), "utf8");
    expect(() => createWindowsTerminalAdapter(malformedPath).read()).toThrow(malformedPath);
  });

  it("never leaves a dangling comma when schemes[] or profiles.defaults starts out empty", () => {
    const minimalPath = path.join(settingsDir, "minimal.json");
    writeFileSync(minimalPath, JSON.stringify({ profiles: { defaults: {} }, schemes: [] }), "utf8");

    createWindowsTerminalAdapter(minimalPath).apply(ZEROX96F_SCHEME);

    const resultText = readFileSync(minimalPath, "utf8");
    const parsed = parseWritten(resultText) as { theme?: unknown; profiles: { defaults: { colorScheme?: unknown } } };
    expect(parsed.theme).toBe("dark");
    expect(parsed.profiles.defaults.colorScheme).toBe("0x96f");
    // A trailing comma right before a closing bracket would still parse under
    // allowTrailingComma — assert directly that this adapter never writes one.
    expect(resultText).not.toMatch(/,\s*[\]}]/);
  });

  it("refuses to apply when there is no settings.json to edit", () => {
    const adapter = createWindowsTerminalAdapter(path.join(settingsDir, "missing.json"));
    expect(() => adapter.apply(ZEROX96F_SCHEME)).toThrow();
  });

  it("reloads without touching the file — Windows Terminal picks the change up on its own", () => {
    const settingsPath = path.join(settingsDir, "settings.json");
    writeFileSync(settingsPath, LF_FIXTURE, "utf8");

    createWindowsTerminalAdapter(settingsPath).reload();
    expect(readFileSync(settingsPath, "utf8")).toBe(LF_FIXTURE);
  });
});

describe("selectedFontFace", () => {
  it("prefers the nested font.face over the legacy flat fontFace when both are present — the shape Windows Terminal itself honours", () => {
    const settingsPath = path.join(mkdtempSync(path.join(tmpdir(), "chameleon-windows-terminal-font-")), "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({ profiles: { defaults: { font: { face: "CaskaydiaCove NF" }, fontFace: "Cascadia Mono" } } }),
      "utf8",
    );
    expect(selectedFontFace(createWindowsTerminalAdapter(settingsPath).read())).toBe("CaskaydiaCove NF");
  });

  it("falls back to the legacy flat fontFace when there is no nested font.face", () => {
    // The hostile fixture used throughout this file carries only the flat shape.
    const settingsDir = mkdtempSync(path.join(tmpdir(), "chameleon-windows-terminal-font-"));
    const settingsPath = path.join(settingsDir, "settings.json");
    writeFileSync(settingsPath, LF_FIXTURE, "utf8");
    expect(selectedFontFace(createWindowsTerminalAdapter(settingsPath).read())).toBe("Cascadia Mono");
  });

  it("is undefined when neither shape is present", () => {
    const settingsPath = path.join(mkdtempSync(path.join(tmpdir(), "chameleon-windows-terminal-font-")), "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ profiles: { defaults: {} } }), "utf8");
    expect(selectedFontFace(createWindowsTerminalAdapter(settingsPath).read())).toBeUndefined();
  });
});

// CHM-27: this is the exact comparison `ch current`/`ch doctor` use to
// notice a target that has drifted from the recorded pack.
describe("windowsTerminalMatchesScheme", () => {
  let settingsDir: string;
  let settingsPath: string;

  beforeEach(() => {
    settingsDir = mkdtempSync(path.join(tmpdir(), "chameleon-windows-terminal-drift-"));
    settingsPath = path.join(settingsDir, "settings.json");
    writeFileSync(settingsPath, LF_FIXTURE, "utf8");
  });

  afterEach(() => {
    rmSync(settingsDir, { recursive: true, force: true });
  });

  it("matches right after apply", () => {
    const adapter = createWindowsTerminalAdapter(settingsPath);
    adapter.apply(ZEROX96F_SCHEME);

    expect(windowsTerminalMatchesScheme(adapter.read(), ZEROX96F_SCHEME)).toBe(true);
  });

  it("does not match a scheme other than the one last applied", () => {
    const adapter = createWindowsTerminalAdapter(settingsPath);
    adapter.apply(ZEROX96F_SCHEME);

    expect(windowsTerminalMatchesScheme(adapter.read(), AARDVARK_BLUE_SCHEME)).toBe(false);
  });

  it("does not match a config that was never themed by Chameleon at all", () => {
    expect(windowsTerminalMatchesScheme(createWindowsTerminalAdapter(settingsPath).read(), ZEROX96F_SCHEME)).toBe(false);
  });
});

describe("selectWindowsTerminalFont", () => {
  let settingsDir: string;

  beforeEach(() => {
    settingsDir = mkdtempSync(path.join(tmpdir(), "chameleon-windows-terminal-select-font-"));
  });

  afterEach(() => {
    rmSync(settingsDir, { recursive: true, force: true });
  });

  it("updates the nested font.face in place, preserving sibling keys like size — never a second, competing flat fontFace", () => {
    const settingsPath = path.join(settingsDir, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({ profiles: { defaults: { font: { face: "Cascadia Mono", size: 11 } } } }, null, 2),
      "utf8",
    );

    selectWindowsTerminalFont("CaskaydiaCove NF", settingsPath);

    const parsed = parseWritten(readFileSync(settingsPath, "utf8")) as {
      profiles: { defaults: { font?: { face?: unknown; size?: unknown }; fontFace?: unknown } };
    };
    expect(parsed.profiles.defaults.font?.face).toBe("CaskaydiaCove NF");
    expect(parsed.profiles.defaults.font?.size).toBe(11);
    expect(parsed.profiles.defaults.fontFace).toBeUndefined();
  });

  it("updates the legacy flat fontFace in place when that is the shape already on disk", () => {
    const settingsPath = path.join(settingsDir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ profiles: { defaults: { fontFace: "Cascadia Mono" } } }, null, 2), "utf8");

    selectWindowsTerminalFont("CaskaydiaCove NF", settingsPath);

    const resultText = readFileSync(settingsPath, "utf8");
    const parsed = parseWritten(resultText) as { profiles: { defaults: { font?: unknown; fontFace?: unknown } } };
    expect(parsed.profiles.defaults.fontFace).toBe("CaskaydiaCove NF");
    expect(parsed.profiles.defaults.font).toBeUndefined();
    expect(countOccurrences(resultText, '"fontFace"')).toBe(1);
  });

  it("defaults to the nested shape when neither is present yet — what a fresh Windows Terminal install writes", () => {
    const settingsPath = path.join(settingsDir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ profiles: { defaults: {} } }, null, 2), "utf8");

    selectWindowsTerminalFont("CaskaydiaCove NF", settingsPath);

    const parsed = parseWritten(readFileSync(settingsPath, "utf8")) as {
      profiles: { defaults: { font?: { face?: unknown }; fontFace?: unknown } };
    };
    expect(parsed.profiles.defaults.font?.face).toBe("CaskaydiaCove NF");
    expect(parsed.profiles.defaults.fontFace).toBeUndefined();
  });

  it("preserves unrelated settings, comments and key order untouched by a font selection", () => {
    const settingsPath = path.join(settingsDir, "settings.json");
    writeFileSync(settingsPath, LF_FIXTURE, "utf8");

    selectWindowsTerminalFont("CaskaydiaCove NF", settingsPath);

    const resultText = readFileSync(settingsPath, "utf8");
    expect(resultText).toContain("// Windows Terminal user configuration");
    expect(resultText).toContain('"colorScheme": "Campbell"');
    expect(resultText).toContain("// keep the tab bar out of the way");
    const parsed = parseWritten(resultText) as { profiles: { defaults: { fontFace?: unknown } } };
    expect(parsed.profiles.defaults.fontFace).toBe("CaskaydiaCove NF");
  });

  it("is idempotent — selecting the same font twice produces the same file, one marked block, never accumulating", () => {
    const settingsPath = path.join(settingsDir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ profiles: { defaults: { fontFace: "Cascadia Mono" } } }, null, 2), "utf8");

    selectWindowsTerminalFont("CaskaydiaCove NF", settingsPath);
    const afterFirstSelect = readFileSync(settingsPath, "utf8");
    selectWindowsTerminalFont("CaskaydiaCove NF", settingsPath);
    const afterSecondSelect = readFileSync(settingsPath, "utf8");

    expect(afterSecondSelect).toBe(afterFirstSelect);
    expect(countOccurrences(afterSecondSelect, "// ch:begin")).toBe(1);
  });

  it("backs up before writing, and undo restores the pre-selection font", () => {
    const settingsPath = path.join(settingsDir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ profiles: { defaults: { fontFace: "Cascadia Mono" } } }, null, 2), "utf8");
    const originalText = readFileSync(settingsPath, "utf8");

    selectWindowsTerminalFont("CaskaydiaCove NF", settingsPath);
    expect(readFileSync(settingsPath, "utf8")).not.toBe(originalText);
    expect(readFileSync(`${settingsPath}.chameleon-backup`, "utf8")).toBe(originalText);

    undoWindowsTerminal(settingsPath);
    expect(readFileSync(settingsPath, "utf8")).toBe(originalText);
  });
});
