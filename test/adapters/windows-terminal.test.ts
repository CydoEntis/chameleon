import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWindowsTerminalAdapter, undoWindowsTerminal } from "../../src/adapters/windows-terminal.js";
import { parseScheme, type Scheme } from "../../src/palette/scheme.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(currentDir, "fixtures", "settings.jsonc");

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
  const originalLines = original.split("\n");
  const resultLines = result.split("\n");
  let originalIndex = 0;
  for (const resultLine of resultLines) {
    if (originalIndex < originalLines.length && resultLine === originalLines[originalIndex]) {
      originalIndex += 1;
    }
  }
  return originalIndex === originalLines.length;
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("windows terminal adapter", () => {
  let settingsDir: string;
  let settingsPath: string;

  beforeEach(() => {
    settingsDir = mkdtempSync(path.join(tmpdir(), "chameleon-windows-terminal-"));
    settingsPath = path.join(settingsDir, "settings.json");
    writeFileSync(settingsPath, readFileSync(FIXTURE_PATH, "utf8"), "utf8");
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

  it("names the file and the problem when a config it must edit is shaped wrong", () => {
    const malformedPath = path.join(settingsDir, "malformed.json");
    writeFileSync(malformedPath, JSON.stringify({ profiles: "not an object" }), "utf8");
    expect(() => createWindowsTerminalAdapter(malformedPath).read()).toThrow(malformedPath);
  });

  it("upserts the scheme, the default colour scheme and the top-level theme, touching nothing else", () => {
    const originalText = readFileSync(settingsPath, "utf8");

    createWindowsTerminalAdapter(settingsPath).apply(ZEROX96F_SCHEME);

    const resultText = readFileSync(settingsPath, "utf8");
    expect(everyOriginalLineSurvivesInOrder(originalText, resultText)).toBe(true);

    // The unrelated scheme, comments and hand-written formatting are still there.
    expect(resultText).toContain("// Windows Terminal user configuration");
    expect(resultText).toContain('"name": "Campbell"');
    expect(resultText).toContain('"fontFace": "Cascadia Mono"');
    expect(resultText).toContain("// keep the tab bar out of the way");

    // The three marked edits landed.
    expect(resultText).toContain('"name": "0x96f"');
    expect(resultText).toContain('"colorScheme": "0x96f"');
    expect(resultText).toContain('"theme": "dark"'); // 0x96f's background (#262427) is dark

    const parsed: unknown = parseJsonc(resultText, [], { allowTrailingComma: true });
    expect(parsed).toMatchObject({
      theme: "dark",
      profiles: { defaults: { colorScheme: "0x96f" } },
    });
  });

  it("is idempotent — applying the same theme twice produces the same file", () => {
    const adapter = createWindowsTerminalAdapter(settingsPath);

    adapter.apply(ZEROX96F_SCHEME);
    const afterFirstApply = readFileSync(settingsPath, "utf8");

    adapter.apply(ZEROX96F_SCHEME);
    const afterSecondApply = readFileSync(settingsPath, "utf8");

    expect(afterSecondApply).toBe(afterFirstApply);
  });

  it("upserts in place when a different theme is applied later, instead of accumulating marked blocks", () => {
    const adapter = createWindowsTerminalAdapter(settingsPath);

    adapter.apply(ZEROX96F_SCHEME);
    adapter.apply(AARDVARK_BLUE_SCHEME);

    const resultText = readFileSync(settingsPath, "utf8");
    expect(resultText).toContain('"name": "Aardvark Blue"');
    expect(resultText).not.toContain('"name": "0x96f"');
    expect(resultText).toContain('"colorScheme": "Aardvark Blue"');
    // One marked block each for schemes, profiles.defaults and the top-level theme — never more.
    expect(countOccurrences(resultText, "// ch:begin")).toBe(3);
  });

  it("never leaves a dangling comma when schemes[] or profiles.defaults starts out empty", () => {
    const minimalPath = path.join(settingsDir, "minimal.json");
    writeFileSync(
      minimalPath,
      JSON.stringify({ profiles: { defaults: {} }, schemes: [] }),
      "utf8",
    );

    createWindowsTerminalAdapter(minimalPath).apply(ZEROX96F_SCHEME);

    const resultText = readFileSync(minimalPath, "utf8");
    const parsed: unknown = parseJsonc(resultText, [], { allowTrailingComma: true });
    expect(parsed).toMatchObject({
      theme: "dark",
      profiles: { defaults: { colorScheme: "0x96f" } },
    });
    // A trailing comma right before a closing bracket would still parse under
    // allowTrailingComma — assert directly that this adapter never writes one.
    expect(resultText).not.toMatch(/,\s*[\]}]/);
  });

  it("writes a backup before every apply, and undo restores it exactly", () => {
    const originalText = readFileSync(settingsPath, "utf8");

    createWindowsTerminalAdapter(settingsPath).apply(ZEROX96F_SCHEME);
    expect(readFileSync(settingsPath, "utf8")).not.toBe(originalText);
    expect(readFileSync(`${settingsPath}.chameleon-backup`, "utf8")).toBe(originalText);

    undoWindowsTerminal(settingsPath);
    expect(readFileSync(settingsPath, "utf8")).toBe(originalText);
  });

  it("refuses to apply when there is no settings.json to edit", () => {
    const adapter = createWindowsTerminalAdapter(path.join(settingsDir, "missing.json"));
    expect(() => adapter.apply(ZEROX96F_SCHEME)).toThrow();
  });

  it("reloads without touching the file — Windows Terminal picks the change up on its own", () => {
    const beforeReload = readFileSync(settingsPath, "utf8");
    createWindowsTerminalAdapter(settingsPath).reload();
    expect(readFileSync(settingsPath, "utf8")).toBe(beforeReload);
  });
});
