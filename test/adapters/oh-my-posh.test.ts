import type { SpawnSyncReturns } from "node:child_process";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addSegment,
  buildLayoutSegment,
  createOhMyPoshAdapter,
  moveSegmentBetweenBlocks,
  readOhMyPoshLayout,
  removeSegment,
  reorderSegment,
  undoOhMyPosh,
  writeOhMyPoshLayout,
  type Layout,
  type LayoutSegment,
} from "../../src/adapters/oh-my-posh.js";
import { ROLES } from "../../src/constants.js";
import { parseScheme, type Scheme } from "../../src/palette/scheme.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

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

  it("detects Oh My Posh by its own installed binary, never by POSH_THEME or an active config", () => {
    // The regression this ticket exists to fix: a shell that never ran
    // `oh-my-posh init` has no POSH_THEME set, and CHM-7 reported that shell
    // as "not found" even with Oh My Posh fully installed and configured
    // elsewhere. Detection must succeed here regardless of configPath.
    vi.mocked(spawnSync).mockReturnValueOnce(makeSpawnResult({ status: 0, stdout: "v3.100.0" }));
    expect(createOhMyPoshAdapter(undefined, profilePath, pointerPath).detect()).toBe(true);

    vi.mocked(spawnSync).mockReturnValueOnce(makeSpawnResult({ error: new Error("ENOENT"), status: null }));
    expect(createOhMyPoshAdapter(configPath, profilePath, pointerPath).detect()).toBe(false);
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

  describe("layout — ch edit's segment editor", () => {
    it("reads the fixture's existing left block, and no right block yet", () => {
      const layout = readOhMyPoshLayout(configPath);
      expect(layout.left).toEqual([
        { type: "path", style: "plain", foreground: "p:accent", properties: { style: "full" } },
        { type: "text", style: "plain", foreground: "p:muted" },
      ]);
      expect(layout.right).toEqual([]);
    });

    it("adds a segment to the right-hand status line, and it round-trips through a write and a read", () => {
      const layout = readOhMyPoshLayout(configPath);
      const withStatus = addSegment(layout, "right", buildLayoutSegment("battery", "muted"));
      writeOhMyPoshLayout(withStatus, configPath);

      expect(readOhMyPoshLayout(configPath).right).toEqual([{ type: "battery", foreground: "p:muted" }]);
    });

    it("adds, reorders, moves between blocks and removes — the full life cycle survives a read back", () => {
      const initial = readOhMyPoshLayout(configPath);
      const withTime = addSegment(initial, "right", buildLayoutSegment("time", "accent"));
      const withBattery = addSegment(withTime, "right", buildLayoutSegment("battery", "muted"), 0);
      const reordered = reorderSegment(withBattery, "right", 0, 1);
      const moved = moveSegmentBetweenBlocks(reordered, "right", 0, "left");
      const final = removeSegment(moved, "left", 0);
      writeOhMyPoshLayout(final, configPath);

      const readBack = readOhMyPoshLayout(configPath);
      // The original path segment was removed at index 0, leaving only the
      // original text segment plus the moved-in time segment.
      expect(readBack.left).toEqual([{ type: "text", style: "plain", foreground: "p:muted" }, { type: "time", foreground: "p:accent" }]);
      expect(readBack.right).toEqual([{ type: "battery", foreground: "p:muted" }]);
    });

    it("leaves the palette untouched — ch edit operates on the layout file only", () => {
      const layout = readOhMyPoshLayout(configPath);
      writeOhMyPoshLayout(addSegment(layout, "right", buildLayoutSegment("os", "accent")), configPath);

      const resultText = readFileSync(configPath, "utf8");
      const parsed = parseWritten(resultText) as { palette: Record<string, string> };
      expect(parsed.palette["accent"]).toBe("#89b4fa");
      expect(parsed.palette["muted"]).toBe("#6c7086");
      // The palette's own hand-written comment survives — this edit never
      // touched that region at all.
      expect(resultText).toContain("picked this from the theme picker ages ago");
    });

    it("is marker-scoped, backed up, and idempotent — writing the same layout twice leaves one blocks marker", () => {
      const layout = addSegment(readOhMyPoshLayout(configPath), "right", buildLayoutSegment("time", "accent"));

      writeOhMyPoshLayout(layout, configPath);
      expect(readFileSync(`${configPath}.chameleon-backup`, "utf8")).toBe(configFixture);
      const afterFirstWrite = readFileSync(configPath, "utf8");

      writeOhMyPoshLayout(layout, configPath);
      const afterSecondWrite = readFileSync(configPath, "utf8");

      expect(afterSecondWrite).toBe(afterFirstWrite);
      expect(countOccurrences(afterSecondWrite, "// ch:begin blocks")).toBe(1);
      expect(usesOnlyLineEnding(afterSecondWrite, eol)).toBe(true);
    });

    it("survives a theme swap — a layout edit made before applying a theme is still there after", () => {
      const adapter = createOhMyPoshAdapter(configPath, profilePath, pointerPath);
      const layout = addSegment(readOhMyPoshLayout(configPath), "right", buildLayoutSegment("battery", "success"));
      writeOhMyPoshLayout(layout, configPath);

      adapter.apply(ZEROX96F_SCHEME);

      const afterApply = readOhMyPoshLayout(configPath);
      expect(afterApply.right).toEqual([{ type: "battery", foreground: "p:success" }]);
      const parsed = parseWritten(readFileSync(configPath, "utf8")) as { palette: Record<string, string> };
      expect(parsed.palette["success"]).toMatch(/^#[0-9a-f]{6}$/i);
    });

    it("a theme swap survives a later layout edit — apply first, then edit, and the palette holds", () => {
      const adapter = createOhMyPoshAdapter(configPath, profilePath, pointerPath);
      adapter.apply(ZEROX96F_SCHEME);
      const appliedPalette = (parseWritten(readFileSync(configPath, "utf8")) as { palette: Record<string, string> }).palette;

      const layout = addSegment(readOhMyPoshLayout(configPath), "right", buildLayoutSegment("battery", "success"));
      writeOhMyPoshLayout(layout, configPath);

      const resultText = readFileSync(configPath, "utf8");
      expect((parseWritten(resultText) as { palette: Record<string, string> }).palette).toEqual(appliedPalette);
      expect(readOhMyPoshLayout(configPath).right).toEqual([{ type: "battery", foreground: "p:success" }]);
    });

    it("rejects reading a layout that already references an undefined role, naming the role", () => {
      const configWithBadRole = configFixture.replace('"foreground": "p:muted"', '"foreground": "p:brand"');
      writeFileSync(configPath, configWithBadRole, "utf8");

      expect(() => readOhMyPoshLayout(configPath)).toThrow(/brand/);
    });
  });
});

describe("layout — pure segment operations", () => {
  const pathSegment: LayoutSegment = buildLayoutSegment("path", "accent");
  const gitSegment: LayoutSegment = buildLayoutSegment("git", "body", "muted");
  const emptyLayout: Layout = { left: [], right: [] };

  it("builds a segment coloured entirely by role reference, never a literal hex", () => {
    const segment = buildLayoutSegment("git", "accent", "muted");
    expect(segment["foreground"]).toBe("p:accent");
    expect(segment["background"]).toBe("p:muted");
    // No hex ever appears anywhere on the built segment's own values.
    expect(Object.values(segment).some((value) => typeof value === "string" && /^#[0-9a-f]{3,8}$/i.test(value))).toBe(false);
  });

  it("omits background entirely when none is given, rather than writing it as undefined", () => {
    const segment = buildLayoutSegment("text", "muted");
    expect("background" in segment).toBe(false);
  });

  it("adds a segment to the end of a block by default", () => {
    const layout = addSegment(addSegment(emptyLayout, "left", pathSegment), "left", gitSegment);
    expect(layout.left).toEqual([pathSegment, gitSegment]);
    expect(layout.right).toEqual([]);
  });

  it("adds a segment at a given index, shifting the rest right", () => {
    const withPath = addSegment(emptyLayout, "left", pathSegment);
    const layout = addSegment(withPath, "left", gitSegment, 0);
    expect(layout.left).toEqual([gitSegment, pathSegment]);
  });

  it("rejects an out-of-range insert index, naming the block", () => {
    expect(() => addSegment(emptyLayout, "right", pathSegment, 5)).toThrow(/right/);
  });

  it("removes the segment at the given index, leaving the rest in order", () => {
    const withBoth = addSegment(addSegment(emptyLayout, "left", pathSegment), "left", gitSegment);
    expect(removeSegment(withBoth, "left", 0).left).toEqual([gitSegment]);
  });

  it("rejects an out-of-range remove index", () => {
    expect(() => removeSegment(emptyLayout, "left", 0)).toThrow(/index 0/);
  });

  it("reorders a segment within its own block", () => {
    const withThree = addSegment(addSegment(addSegment(emptyLayout, "left", pathSegment), "left", gitSegment), "left", pathSegment);
    const reordered = reorderSegment(withThree, "left", 0, 2);
    expect(reordered.left).toEqual([gitSegment, pathSegment, pathSegment]);
  });

  it("moves a segment from one block to the other, appending by default", () => {
    const withPath = addSegment(emptyLayout, "left", pathSegment);
    const moved = moveSegmentBetweenBlocks(withPath, "left", 0, "right");
    expect(moved.left).toEqual([]);
    expect(moved.right).toEqual([pathSegment]);
  });

  it("moves a segment to a specific index in the destination block", () => {
    const layout = addSegment(addSegment(emptyLayout, "left", pathSegment), "right", gitSegment);
    const moved = moveSegmentBetweenBlocks(layout, "left", 0, "right", 0);
    expect(moved.right).toEqual([pathSegment, gitSegment]);
  });

  it("rejects a layout segment that references a role Chameleon does not know, naming the role", () => {
    // Hand-built rather than through buildLayoutSegment, which only ever
    // accepts a real Role — this is what a hand-edited or corrupted config
    // can still smuggle in, and addSegment must catch it just the same.
    const segmentWithBadRole: LayoutSegment = { type: "text", foreground: "p:brand" };
    expect(() => addSegment(emptyLayout, "left", segmentWithBadRole)).toThrow(/brand/);
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
