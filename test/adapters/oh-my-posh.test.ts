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
  isSegmentType,
  layoutBlocksOnSide,
  moveSegmentBetweenBlocks,
  ohMyPoshMatchesRoleHexes,
  readOhMyPoshLayout,
  removeSegment,
  reorderSegment,
  undoOhMyPosh,
  writeOhMyPoshLayout,
  type Layout,
  type LayoutSegment,
} from "../../src/adapters/oh-my-posh.js";
import { ROLES } from "../../src/constants.js";
import { resolveRoleHexes } from "../../src/palette/repair.js";
import { parseScheme, type Scheme } from "../../src/palette/scheme.js";
import { loadCuratedThemePacks } from "../../src/palette/theme-pack-library.js";

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
// The real, unmodified "chips" Oh My Posh theme (JanDeDobbeleer/oh-my-posh,
// themes/chips.omp.json) — CHM-16's "verified against a real, unmodified
// community theme," not a Chameleon-generated layout. It carries two "left"
// blocks, palette keys Chameleon does not own (e.g. "c-badge-text"), and
// segment types outside Chameleon's old ten-type list (node, python, rust, …).
const CHIPS_FIXTURE_PATH = path.join(currentDir, "fixtures", "chips.omp.json");

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

/** Every distinct role name referenced as "p:role" anywhere in `configText` that `paletteTable` does not define — CHM-31's failure mode, checked from the test side independently of the adapter's own internal assertion. */
function undefinedPaletteReferences(configText: string, paletteTable: Record<string, string>): string[] {
  const referencedRoles = new Set<string>();
  for (const match of configText.matchAll(/p:([A-Za-z0-9_-]+)/g)) {
    const referencedRole = match[1];
    if (referencedRole !== undefined) referencedRoles.add(referencedRole);
  }
  return [...referencedRoles].filter((referencedRole) => !(referencedRole in paletteTable));
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
      const leftBlocks = layoutBlocksOnSide(layout, "left");
      expect(leftBlocks).toHaveLength(1);
      expect(leftBlocks[0]?.segments).toEqual([
        { type: "path", style: "plain", foreground: "p:accent", properties: { style: "full" } },
        { type: "text", style: "plain", foreground: "p:muted" },
      ]);
      expect(layoutBlocksOnSide(layout, "right")).toEqual([]);
    });

    it("adds a segment to the right-hand status line, and it round-trips through a write and a read", () => {
      const layout = readOhMyPoshLayout(configPath);
      const withStatus = addSegment(layout, "right", 0, buildLayoutSegment("battery", "muted"));
      writeOhMyPoshLayout(withStatus, configPath);

      expect(layoutBlocksOnSide(readOhMyPoshLayout(configPath), "right")[0]?.segments).toEqual([{ type: "battery", foreground: "p:muted" }]);
    });

    it("adds, reorders, moves between blocks and removes — the full life cycle survives a read back", () => {
      const initial = readOhMyPoshLayout(configPath);
      const withTime = addSegment(initial, "right", 0, buildLayoutSegment("time", "accent"));
      const withBattery = addSegment(withTime, "right", 0, buildLayoutSegment("battery", "muted"), 0);
      const reordered = reorderSegment(withBattery, "right", 0, 0, 1);
      const moved = moveSegmentBetweenBlocks(reordered, "right", 0, 0, "left", 0);
      const final = removeSegment(moved, "left", 0, 0);
      writeOhMyPoshLayout(final, configPath);

      const readBack = readOhMyPoshLayout(configPath);
      // The original path segment was removed at index 0, leaving only the
      // original text segment plus the moved-in time segment.
      expect(layoutBlocksOnSide(readBack, "left")[0]?.segments).toEqual([
        { type: "text", style: "plain", foreground: "p:muted" },
        { type: "time", foreground: "p:accent" },
      ]);
      expect(layoutBlocksOnSide(readBack, "right")[0]?.segments).toEqual([{ type: "battery", foreground: "p:muted" }]);
    });

    it("leaves the palette untouched — ch edit operates on the layout file only", () => {
      const layout = readOhMyPoshLayout(configPath);
      writeOhMyPoshLayout(addSegment(layout, "right", 0, buildLayoutSegment("os", "accent")), configPath);

      const resultText = readFileSync(configPath, "utf8");
      const parsed = parseWritten(resultText) as { palette: Record<string, string> };
      expect(parsed.palette["accent"]).toBe("#89b4fa");
      expect(parsed.palette["muted"]).toBe("#6c7086");
      // The palette's own hand-written comment survives — this edit never
      // touched that region at all.
      expect(resultText).toContain("picked this from the theme picker ages ago");
    });

    it("is marker-scoped, backed up, and idempotent — writing the same layout twice leaves one blocks marker", () => {
      const layout = addSegment(readOhMyPoshLayout(configPath), "right", 0, buildLayoutSegment("time", "accent"));

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
      const layout = addSegment(readOhMyPoshLayout(configPath), "right", 0, buildLayoutSegment("battery", "success"));
      writeOhMyPoshLayout(layout, configPath);

      adapter.apply(ZEROX96F_SCHEME);

      const afterApply = readOhMyPoshLayout(configPath);
      expect(layoutBlocksOnSide(afterApply, "right")[0]?.segments).toEqual([{ type: "battery", foreground: "p:success" }]);
      const parsed = parseWritten(readFileSync(configPath, "utf8")) as { palette: Record<string, string> };
      expect(parsed.palette["success"]).toMatch(/^#[0-9a-f]{6}$/i);
    });

    it("a theme swap survives a later layout edit — apply first, then edit, and the palette holds", () => {
      const adapter = createOhMyPoshAdapter(configPath, profilePath, pointerPath);
      adapter.apply(ZEROX96F_SCHEME);
      const appliedPalette = (parseWritten(readFileSync(configPath, "utf8")) as { palette: Record<string, string> }).palette;

      const layout = addSegment(readOhMyPoshLayout(configPath), "right", 0, buildLayoutSegment("battery", "success"));
      writeOhMyPoshLayout(layout, configPath);

      const resultText = readFileSync(configPath, "utf8");
      expect((parseWritten(resultText) as { palette: Record<string, string> }).palette).toEqual(appliedPalette);
      expect(layoutBlocksOnSide(readOhMyPoshLayout(configPath), "right")[0]?.segments).toEqual([{ type: "battery", foreground: "p:success" }]);
    });

    it("reads a segment referencing a palette key Chameleon does not own without throwing — left alone, not rejected (CHM-16)", () => {
      // CHM-8 required rejecting this outright; CHM-16 walks that back — a
      // real theme like chips defines its own palette keys freely, and this
      // read must not block an edit to segments that have nothing to do
      // with the foreign one.
      const configWithForeignRole = configFixture.replace('"foreground": "p:muted"', '"foreground": "p:c-badge-text"');
      writeFileSync(configPath, configWithForeignRole, "utf8");

      const layout = readOhMyPoshLayout(configPath);
      expect(layoutBlocksOnSide(layout, "left")[0]?.segments).toEqual([
        { type: "path", style: "plain", foreground: "p:accent", properties: { style: "full" } },
        { type: "text", style: "plain", foreground: "p:c-badge-text" },
      ]);
    });

    it("reorders around a segment carrying a foreign palette key without adopting it — it round-trips byte-for-byte", () => {
      const configWithForeignRole = configFixture.replace('"foreground": "p:muted"', '"foreground": "p:c-badge-text"');
      writeFileSync(configPath, configWithForeignRole, "utf8");

      // Add a brand-new segment elsewhere; the foreign-keyed "text" segment
      // is never touched by this edit and must survive it unchanged.
      const layout = readOhMyPoshLayout(configPath);
      const reordered = reorderSegment(layout, "left", 0, 0, 1);
      writeOhMyPoshLayout(addSegment(reordered, "right", 0, buildLayoutSegment("os", "accent")), configPath);

      const readBack = readOhMyPoshLayout(configPath);
      expect(layoutBlocksOnSide(readBack, "left")[0]?.segments).toEqual([
        { type: "text", style: "plain", foreground: "p:c-badge-text" },
        { type: "path", style: "plain", foreground: "p:accent", properties: { style: "full" } },
      ]);
    });
  });

  describe("layout — multiple blocks per side (CHM-16)", () => {
    it("addresses a second block on the same side by its own block index, leaving the first untouched", () => {
      const configWithTwoLeftBlocks = configFixture.replace(
        /"blocks":\s*\[/,
        '"blocks": [{ "type": "prompt", "alignment": "left", "newline": true, "segments": [{ "type": "os", "foreground": "p:accent" }] },',
      );
      writeFileSync(configPath, configWithTwoLeftBlocks, "utf8");

      const layout = readOhMyPoshLayout(configPath);
      const leftBlocks = layoutBlocksOnSide(layout, "left");
      expect(leftBlocks).toHaveLength(2);
      expect(leftBlocks[0]?.segments).toEqual([{ type: "os", foreground: "p:accent" }]);
      expect(leftBlocks[0]?.extra).toEqual({ newline: true });
      expect(leftBlocks[1]?.segments).toEqual([
        { type: "path", style: "plain", foreground: "p:accent", properties: { style: "full" } },
        { type: "text", style: "plain", foreground: "p:muted" },
      ]);

      const withRemoval = removeSegment(layout, "left", 1, 1);
      writeOhMyPoshLayout(withRemoval, configPath);

      const readBack = readOhMyPoshLayout(configPath);
      const readBackLeftBlocks = layoutBlocksOnSide(readBack, "left");
      // The first block — the one carrying "newline": true — is completely
      // untouched, including that extra property, by an edit addressed at
      // the second block only.
      expect(readBackLeftBlocks[0]?.segments).toEqual([{ type: "os", foreground: "p:accent" }]);
      expect(readBackLeftBlocks[0]?.extra).toEqual({ newline: true });
      expect(readBackLeftBlocks[1]?.segments).toEqual([
        { type: "path", style: "plain", foreground: "p:accent", properties: { style: "full" } },
      ]);
    });
  });
});

describe("layout — pure segment operations", () => {
  const pathSegment: LayoutSegment = buildLayoutSegment("path", "accent");
  const gitSegment: LayoutSegment = buildLayoutSegment("git", "body", "muted");
  const emptyLayout: Layout = { blocks: [] };

  function segmentsOf(layout: Layout, alignment: "left" | "right", blockIndex = 0): readonly LayoutSegment[] {
    return layoutBlocksOnSide(layout, alignment)[blockIndex]?.segments ?? [];
  }

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

  it("adds a segment to the end of a block by default, creating the block on first use", () => {
    const layout = addSegment(addSegment(emptyLayout, "left", 0, pathSegment), "left", 0, gitSegment);
    expect(segmentsOf(layout, "left")).toEqual([pathSegment, gitSegment]);
    expect(layoutBlocksOnSide(layout, "right")).toEqual([]);
  });

  it("adds a segment at a given index, shifting the rest right", () => {
    const withPath = addSegment(emptyLayout, "left", 0, pathSegment);
    const layout = addSegment(withPath, "left", 0, gitSegment, 0);
    expect(segmentsOf(layout, "left")).toEqual([gitSegment, pathSegment]);
  });

  it("rejects an out-of-range insert index, naming the block", () => {
    expect(() => addSegment(emptyLayout, "right", 0, pathSegment, 5)).toThrow(/"right" block 0/);
  });

  it("rejects a block index that does not exist yet, naming the side and its block count", () => {
    expect(() => addSegment(emptyLayout, "right", 2, pathSegment)).toThrow(/"right".*0 block/);
  });

  it("removes the segment at the given index, leaving the rest in order", () => {
    const withBoth = addSegment(addSegment(emptyLayout, "left", 0, pathSegment), "left", 0, gitSegment);
    expect(segmentsOf(removeSegment(withBoth, "left", 0, 0), "left")).toEqual([gitSegment]);
  });

  it("rejects an out-of-range remove index", () => {
    const withPath = addSegment(emptyLayout, "left", 0, pathSegment);
    expect(() => removeSegment(withPath, "left", 0, 5)).toThrow(/index 5/);
  });

  it("rejects a remove on a block index that does not exist", () => {
    expect(() => removeSegment(emptyLayout, "left", 0, 0)).toThrow(/"left".*0 block/);
  });

  it("reorders a segment within its own block", () => {
    const withThree = addSegment(
      addSegment(addSegment(emptyLayout, "left", 0, pathSegment), "left", 0, gitSegment),
      "left",
      0,
      pathSegment,
    );
    const reordered = reorderSegment(withThree, "left", 0, 0, 2);
    expect(segmentsOf(reordered, "left")).toEqual([gitSegment, pathSegment, pathSegment]);
  });

  it("moves a segment from one block to the other, appending by default and creating the destination block", () => {
    const withPath = addSegment(emptyLayout, "left", 0, pathSegment);
    const moved = moveSegmentBetweenBlocks(withPath, "left", 0, 0, "right", 0);
    expect(layoutBlocksOnSide(moved, "left")[0]?.segments).toEqual([]);
    expect(segmentsOf(moved, "right")).toEqual([pathSegment]);
  });

  it("moves a segment to a specific index in the destination block", () => {
    const layout = addSegment(addSegment(emptyLayout, "left", 0, pathSegment), "right", 0, gitSegment);
    const moved = moveSegmentBetweenBlocks(layout, "left", 0, 0, "right", 0, 0);
    expect(segmentsOf(moved, "right")).toEqual([pathSegment, gitSegment]);
  });

  it("moves a segment between two blocks on the same side", () => {
    const withFirstBlock = addSegment(emptyLayout, "left", 0, pathSegment);
    const withSecondBlock = addSegment(withFirstBlock, "left", 1, gitSegment);
    const moved = moveSegmentBetweenBlocks(withSecondBlock, "left", 0, 0, "left", 1, 0);
    expect(segmentsOf(moved, "left", 0)).toEqual([]);
    expect(segmentsOf(moved, "left", 1)).toEqual([pathSegment, gitSegment]);
  });

  it("rejects a layout segment that references a role Chameleon does not know, naming the role", () => {
    // Hand-built rather than through buildLayoutSegment, which only ever
    // accepts a real Role — this is what a hand-edited or corrupted config
    // can still smuggle in, and addSegment must catch it just the same.
    const segmentWithBadRole: LayoutSegment = { type: "text", foreground: "p:brand" };
    expect(() => addSegment(emptyLayout, "left", 0, segmentWithBadRole)).toThrow(/brand/);
  });
});

describe("layout — the real, unmodified chips community theme (CHM-16)", () => {
  let stateDir: string;
  let configPath: string;

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(tmpdir(), "chameleon-oh-my-posh-chips-"));
    configPath = path.join(stateDir, "chips.omp.json");
    writeFileSync(configPath, readFileSync(CHIPS_FIXTURE_PATH, "utf8"), "utf8");
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("reads two \"left\" blocks and one \"right\" block without throwing — CHM-8 rejected this outright", () => {
    const layout = readOhMyPoshLayout(configPath);
    expect(layoutBlocksOnSide(layout, "left")).toHaveLength(2);
    expect(layoutBlocksOnSide(layout, "right")).toHaveLength(1);
  });

  it("reads the \"git\" segment's foreign \"p:c-badge-text\" foreground through untouched — CHM-8 rejected this by name", () => {
    const layout = readOhMyPoshLayout(configPath);
    const gitSegment = layoutBlocksOnSide(layout, "left")[0]?.segments.find((segment) => segment["type"] === "git");
    expect(gitSegment?.["foreground"]).toBe("p:c-badge-text");
  });

  it("accepts every segment type the theme actually uses, including ones CHM-8's ten-type list rejected", () => {
    const layout = readOhMyPoshLayout(configPath);
    const segmentTypes = layout.blocks.flatMap((block) => block.segments.map((segment) => segment["type"]));
    // node, python, rust and crystal are exactly the language segments
    // CHM-8's curated ten-type list turned away.
    expect(segmentTypes).toEqual(expect.arrayContaining(["node", "python", "rust", "crystal", "git", "path"]));
    for (const segmentType of segmentTypes) {
      expect(isSegmentType(segmentType)).toBe(true);
    }
  });

  it("reorders the second \"left\" block's own segments, addressed by block index, without disturbing the first block or the foreign-keyed git segment", () => {
    const layout = readOhMyPoshLayout(configPath);
    const secondBlockSegmentCount = layoutBlocksOnSide(layout, "left")[1]?.segments.length ?? 0;
    // Swap the first two segments of the second "left" block (session, text).
    const reordered = reorderSegment(layout, "left", 1, 0, 1);
    writeOhMyPoshLayout(reordered, configPath);

    const readBack = readOhMyPoshLayout(configPath);
    const leftBlocks = layoutBlocksOnSide(readBack, "left");
    expect(leftBlocks[1]?.segments[0]?.["type"]).toBe("text");
    expect(leftBlocks[1]?.segments[1]?.["type"]).toBe("session");
    expect(leftBlocks[1]?.segments).toHaveLength(secondBlockSegmentCount);
    // The first block's own second-row toggle and its git segment's foreign
    // role reference are untouched — this edit only addressed block 1.
    expect(leftBlocks[0]?.extra["newline"]).toBeUndefined();
    const gitSegment = leftBlocks[0]?.segments.find((segment) => segment["type"] === "git");
    expect(gitSegment?.["foreground"]).toBe("p:c-badge-text");
    const secondRowBlock = layoutBlocksOnSide(readBack, "left")[1];
    expect(secondRowBlock?.extra["newline"]).toBe(true);
  });

  it("preserves everything outside the blocks marker, palette keys Chameleon does not own included", () => {
    const layout = readOhMyPoshLayout(configPath);
    writeOhMyPoshLayout(addSegment(layout, "right", 0, buildLayoutSegment("battery", "muted"), 0), configPath);

    const resultText = readFileSync(configPath, "utf8");
    const parsed = parseWritten(resultText) as { palette: Record<string, string> };
    // Every foreign palette key this theme defines for itself survives
    // untouched — ch edit never touches "palette", only "blocks".
    expect(parsed.palette["c-badge-text"]).toBeDefined();
    expect(parsed.palette["c-git-normal"]).toBeDefined();
  });
});

describe("recolouring a foreign palette on theme apply (CHM-31)", () => {
  let stateDir: string;
  let configPath: string;
  let profilePath: string;
  let pointerPath: string;
  let originalChipsText: string;
  let originalPalette: Record<string, string>;

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(tmpdir(), "chameleon-oh-my-posh-chm31-"));
    configPath = path.join(stateDir, "chips.omp.json");
    profilePath = path.join(stateDir, "Microsoft.PowerShell_profile.ps1");
    pointerPath = path.join(stateDir, "oh-my-posh-pointer.json");
    originalChipsText = readFileSync(CHIPS_FIXTURE_PATH, "utf8");
    originalPalette = (parseWritten(originalChipsText) as { palette: Record<string, string> }).palette;
    writeFileSync(configPath, originalChipsText, "utf8");
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("leaves all 47 of chips's own palette keys defined, recoloured, after applying a theme", () => {
    expect(Object.keys(originalPalette)).toHaveLength(47);

    createOhMyPoshAdapter(configPath, profilePath, pointerPath).apply(ZEROX96F_SCHEME);

    const resultPalette = (parseWritten(readFileSync(configPath, "utf8")) as { palette: Record<string, string> }).palette;
    for (const key of Object.keys(originalPalette)) {
      expect(resultPalette[key]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("adds Chameleon's own six roles alongside chips's keys, never in place of them", () => {
    createOhMyPoshAdapter(configPath, profilePath, pointerPath).apply(ZEROX96F_SCHEME);

    const resultPalette = (parseWritten(readFileSync(configPath, "utf8")) as { palette: Record<string, string> }).palette;
    expect(Object.keys(resultPalette)).toHaveLength(47 + ROLES.length);
    for (const key of Object.keys(originalPalette)) {
      expect(resultPalette[key]).toBeDefined();
    }
    for (const role of ROLES) {
      expect(resultPalette[role]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("leaves every segment, block and non-colour field byte-identical", () => {
    const originalBlocks = (parseWritten(originalChipsText) as { blocks: unknown }).blocks;
    const originalConsoleTitle = (parseWritten(originalChipsText) as { console_title_template: unknown }).console_title_template;

    createOhMyPoshAdapter(configPath, profilePath, pointerPath).apply(ZEROX96F_SCHEME);

    const resultText = readFileSync(configPath, "utf8");
    const resultParsed = parseWritten(resultText) as { blocks: unknown; console_title_template: unknown };
    expect(resultParsed.blocks).toEqual(originalBlocks);
    expect(resultParsed.console_title_template).toEqual(originalConsoleTitle);
  });

  it("undoes back to chips's exact original palette", () => {
    createOhMyPoshAdapter(configPath, profilePath, pointerPath).apply(ZEROX96F_SCHEME);
    expect(readFileSync(configPath, "utf8")).not.toBe(originalChipsText);

    undoOhMyPosh(configPath, profilePath);
    expect(readFileSync(configPath, "utf8")).toBe(originalChipsText);
  });

  it("leaves no \"p:\" reference in the config undefined, across every bundled theme", () => {
    // CHM-31's own regression: this used to delete every key chips's
    // segments and templates reference by name and replace them with
    // Chameleon's six role names, leaving those references dangling and the
    // rendered prompt colourless. Checked against the full curated library —
    // every theme `ch <slug>` can actually apply — not just one scheme.
    const curatedPacks = loadCuratedThemePacks();
    expect(curatedPacks.length).toBeGreaterThan(0);

    for (const pack of curatedPacks) {
      writeFileSync(configPath, originalChipsText, "utf8");
      createOhMyPoshAdapter(configPath, profilePath, pointerPath).apply(pack.payloads["windows-terminal"]);

      const resultText = readFileSync(configPath, "utf8");
      const resultPalette = (parseWritten(resultText) as { palette: Record<string, string> }).palette;
      expect(undefinedPaletteReferences(resultText, resultPalette)).toEqual([]);
    }
  });
});

// CHM-27: this is the exact comparison `ch current`/`ch doctor` use to
// notice a target that has drifted from the recorded pack.
describe("ohMyPoshMatchesRoleHexes", () => {
  let stateDir: string;
  let configPath: string;
  let profilePath: string;
  let pointerPath: string;

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(tmpdir(), "chameleon-oh-my-posh-drift-"));
    configPath = path.join(stateDir, "theme.omp.json");
    profilePath = path.join(stateDir, "Microsoft.PowerShell_profile.ps1");
    pointerPath = path.join(stateDir, "oh-my-posh-pointer.json");
    writeFileSync(configPath, LF_CONFIG_FIXTURE, "utf8");
    writeFileSync(profilePath, LF_PROFILE_FIXTURE, "utf8");
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("matches right after apply", () => {
    const adapter = createOhMyPoshAdapter(configPath, profilePath, pointerPath);
    adapter.apply(ZEROX96F_SCHEME);

    expect(ohMyPoshMatchesRoleHexes(adapter.read(), resolveRoleHexes(ZEROX96F_SCHEME))).toBe(true);
  });

  it("does not match a scheme other than the one last applied", () => {
    const adapter = createOhMyPoshAdapter(configPath, profilePath, pointerPath);
    adapter.apply(ZEROX96F_SCHEME);

    expect(ohMyPoshMatchesRoleHexes(adapter.read(), resolveRoleHexes(AARDVARK_BLUE_SCHEME))).toBe(false);
  });

  it("does not match a config that was never themed by Chameleon at all", () => {
    const config = createOhMyPoshAdapter(configPath, profilePath, pointerPath).read();

    expect(ohMyPoshMatchesRoleHexes(config, resolveRoleHexes(ZEROX96F_SCHEME))).toBe(false);
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
