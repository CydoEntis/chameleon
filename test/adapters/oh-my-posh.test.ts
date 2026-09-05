import type { SpawnSyncReturns } from "node:child_process";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addSegment,
  buildLayoutSegment,
  createDefaultOhMyPoshAdapter,
  createOhMyPoshAdapter,
  ensureOhMyPoshOwnedConfigSeeded,
  isSegmentType,
  layoutBlocksOnSide,
  moveSegmentBetweenBlocks,
  ohMyPoshMatchesRoleHexes,
  readOhMyPoshLayout,
  removeSegment,
  reorderSegment,
  undoOhMyPosh,
  withActiveLayoutRespected,
  writeOhMyPoshLayout,
  type Layout,
  type LayoutSegment,
} from "../../src/adapters/oh-my-posh.js";
import { isWindows, resetPlatformProbeCache } from "../../src/adapters/platform.js";
import { writePromptState } from "../../src/adapters/prompt-state.js";
import { ANSI_MIN_RATIO, MUTED_MIN_RATIO, ROLES, TEXT_MIN_RATIO } from "../../src/constants.js";
import { contrastRatio, rgbDistance } from "../../src/palette/color.js";
import { loadBundledPromptPacks } from "../../src/palette/prompt-pack-library.js";
import { resolvePromptLayoutRoleReferences } from "../../src/palette/prompt-pack.js";
import { resolveRoleHexes } from "../../src/palette/repair.js";
import { parseScheme, type Scheme } from "../../src/palette/scheme.js";
import { loadCuratedThemePacks } from "../../src/palette/theme-pack-library.js";
import type { ThemePack } from "../../src/palette/theme-pack.js";

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

/** Every distinct key any "p:" reference in `configText` names, scanned across the whole file rather than just its segments — CHM-43's own "no key left that no segment references" check needs the same reach as undefinedPaletteReferences above, just answering the opposite question: defined but never read, not read but never defined. */
function everyReferencedPaletteKey(configText: string): ReadonlySet<string> {
  const referencedKeys = new Set<string>();
  for (const match of configText.matchAll(/p:([A-Za-z0-9_-]+)/g)) {
    const referencedKey = match[1];
    if (referencedKey !== undefined) referencedKeys.add(referencedKey);
  }
  return referencedKeys;
}

/** Every "p:role" reference `value` carries — zero for anything that is not a string, or a plain string with no such reference. */
function paletteReferencesIn(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return [...value.matchAll(/p:([A-Za-z0-9_-]+)/g)].flatMap((match) => (match[1] !== undefined ? [match[1]] : []));
}

/** Every foreground-key/background-key pair a real config's own segments actually render together — read from each segment's own foreground/background and foreground_templates/background_templates fields (see CHM-16's chips.omp.json), not hand-listed, so this stays correct if the fixture ever changes. A segment with several background candidates (one per battery level, one per git state, …) pairs its one foreground against every one of them, since only one renders at a time but any of them could. */
function segmentForegroundBackgroundPairs(configText: string): ReadonlyArray<readonly [string, string]> {
  const parsed = parseJsonc(configText, [], { allowTrailingComma: true }) as { blocks: Array<{ segments: Array<Record<string, unknown>> }> };
  const pairs: Array<readonly [string, string]> = [];
  for (const block of parsed.blocks) {
    for (const segment of block.segments) {
      const foregroundTemplates = Array.isArray(segment["foreground_templates"]) ? (segment["foreground_templates"] as unknown[]) : [];
      const backgroundTemplates = Array.isArray(segment["background_templates"]) ? (segment["background_templates"] as unknown[]) : [];
      const foregroundKeys = [...paletteReferencesIn(segment["foreground"]), ...foregroundTemplates.flatMap(paletteReferencesIn)];
      const backgroundKeys = [...paletteReferencesIn(segment["background"]), ...backgroundTemplates.flatMap(paletteReferencesIn)];
      for (const foregroundKey of foregroundKeys) {
        for (const backgroundKey of backgroundKeys) {
          pairs.push([foregroundKey, backgroundKey]);
        }
      }
    }
  }
  return pairs;
}

/** Every segment across `configText`'s own blocks that carries at least one resolvable foreground key *and* at least one resolvable background key — CHM-40's own "count of segments actually checked": a fixture, or a check, that only ever exercises one such segment (CHM-37's own miss — see its ticket note) must fail outright, not silently pass on a sample of one. */
function segmentsWithResolvablePairCount(configText: string): number {
  const parsed = parseJsonc(configText, [], { allowTrailingComma: true }) as { blocks: Array<{ segments: Array<Record<string, unknown>> }> };
  let segmentsWithPairs = 0;
  for (const block of parsed.blocks) {
    for (const segment of block.segments) {
      const foregroundTemplates = Array.isArray(segment["foreground_templates"]) ? (segment["foreground_templates"] as unknown[]) : [];
      const backgroundTemplates = Array.isArray(segment["background_templates"]) ? (segment["background_templates"] as unknown[]) : [];
      const foregroundKeys = [...paletteReferencesIn(segment["foreground"]), ...foregroundTemplates.flatMap(paletteReferencesIn)];
      const backgroundKeys = [...paletteReferencesIn(segment["background"]), ...backgroundTemplates.flatMap(paletteReferencesIn)];
      if (foregroundKeys.length > 0 && backgroundKeys.length > 0) segmentsWithPairs += 1;
    }
  }
  return segmentsWithPairs;
}

/** One segment's own foreground key(s) and its fully-resolved background hex(es) — the unit CHM-40's own contrast check walks, and the shape segmentsWithResolvablePairCount counts. */
interface SegmentContrastCheck {
  readonly segmentType: string;
  readonly foregroundKeys: readonly string[];
  readonly backgroundHexes: readonly string[];
}

/** Every segment across `configText`'s own blocks that carries at least one resolvable foreground key and at least one resolvable background hex, resolved through `palette` — the RESULT palette, so an override key CHM-40 minted (see repairSegmentForegrounds) resolves the same as any of chips's own original keys. */
function segmentContrastChecks(configText: string, palette: Readonly<Record<string, string>>): SegmentContrastCheck[] {
  const parsed = parseJsonc(configText, [], { allowTrailingComma: true }) as { blocks: Array<{ segments: Array<Record<string, unknown>> }> };
  const checks: SegmentContrastCheck[] = [];
  for (const block of parsed.blocks) {
    for (const segment of block.segments) {
      const foregroundTemplates = Array.isArray(segment["foreground_templates"]) ? (segment["foreground_templates"] as unknown[]) : [];
      const backgroundTemplates = Array.isArray(segment["background_templates"]) ? (segment["background_templates"] as unknown[]) : [];
      const foregroundKeys = [...new Set([...paletteReferencesIn(segment["foreground"]), ...foregroundTemplates.flatMap(paletteReferencesIn)])];
      const backgroundKeys = [...new Set([...paletteReferencesIn(segment["background"]), ...backgroundTemplates.flatMap(paletteReferencesIn)])];
      const backgroundHexes = backgroundKeys.flatMap((key) => (palette[key] !== undefined ? [palette[key]!] : []));
      if (foregroundKeys.length > 0 && backgroundHexes.length > 0) {
        checks.push({ segmentType: String(segment["type"]), foregroundKeys, backgroundHexes });
      }
    }
  }
  return checks;
}

/**
 * Whether some single colour could clear TEXT_MIN_RATIO against every one
 * of `backgroundHexes` at once, checked against literal black and white —
 * the two extremes able to reach the widest possible contrast ratio at any
 * background. If neither clears every one of them, no colour can: any
 * other hue or chroma only narrows the reachable range further (see
 * repairForegroundAgainstBackgrounds's own "neither pole clears
 * everything"). A segment can genuinely land here — e.g. chips's own
 * battery segment mixes several light, pastel charge-level backgrounds
 * with one dark, implied-"error" one, and no single foreground can read
 * against a background this dark and one this light at once.
 */
function isSingleForegroundAchievable(backgroundHexes: readonly string[]): boolean {
  const clearsEveryBackground = (foregroundHex: string) => backgroundHexes.every((backgroundHex) => contrastRatio(foregroundHex, backgroundHex) >= TEXT_MIN_RATIO);
  return clearsEveryBackground("#000000") || clearsEveryBackground("#ffffff");
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

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(tmpdir(), "chameleon-oh-my-posh-"));
    configPath = path.join(stateDir, "theme.omp.json");
    profilePath = path.join(stateDir, "Microsoft.PowerShell_profile.ps1");
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
    expect(createOhMyPoshAdapter(configPath, profilePath).detect()).toBe(true);

    vi.mocked(spawnSync).mockReturnValueOnce(makeSpawnResult({ error: new Error("ENOENT"), status: null }));
    expect(createOhMyPoshAdapter(configPath, profilePath).detect()).toBe(false);
  });

  it("reads a hostile config — comments and trailing commas included", () => {
    const config = createOhMyPoshAdapter(configPath, profilePath).read();
    expect(config.palette?.["accent"]).toBe("#89b4fa");
    expect(Array.isArray(config.blocks)).toBe(true);
    expect(config["final_space"]).toBe(true);
  });

  it("round-trips every config line byte-identical outside the palette block, its own line endings included", () => {
    createOhMyPoshAdapter(configPath, profilePath).apply(ZEROX96F_SCHEME);

    const resultText = readFileSync(configPath, "utf8");
    expect(everyOriginalLineSurvivesInOrder(configLinesUnrelatedToChameleonEdits(configFixture, eol), resultText)).toBe(true);
    expect(usesOnlyLineEnding(resultText, eol)).toBe(true);
  });

  it("leaves the segment list byte-identical when swapping themes", () => {
    const adapter = createOhMyPoshAdapter(configPath, profilePath);
    const originalBlocks = (parseWritten(configFixture) as { blocks: unknown }).blocks;

    adapter.apply(ZEROX96F_SCHEME);
    adapter.apply(AARDVARK_BLUE_SCHEME);

    const resultBlocks = (parseWritten(readFileSync(configPath, "utf8")) as { blocks: unknown }).blocks;
    expect(resultBlocks).toEqual(originalBlocks);
  });

  it("leaves exactly one palette key, with every Chameleon role resolved to a hex colour", () => {
    createOhMyPoshAdapter(configPath, profilePath).apply(ZEROX96F_SCHEME);

    const resultText = readFileSync(configPath, "utf8");
    expect(countOccurrences(resultText, '"palette"')).toBe(1);
    const parsed = parseWritten(resultText) as { palette: Record<string, string> };
    for (const role of ROLES) {
      expect(parsed.palette[role]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("preserves unrelated comments and settings untouched by any edit", () => {
    createOhMyPoshAdapter(configPath, profilePath).apply(ZEROX96F_SCHEME);

    const resultText = readFileSync(configPath, "utf8");
    expect(resultText).toContain("// Oh My Posh config");
    expect(resultText).toContain("// keep the transient prompt on");
    expect(resultText).toContain('"console_title_template": "{{ .Shell }}"');

    const parsed = parseWritten(resultText) as Record<string, unknown>;
    expect(parsed["final_space"]).toBe(true);
  });

  it("is idempotent — applying the same theme twice produces the same config", () => {
    const adapter = createOhMyPoshAdapter(configPath, profilePath);

    adapter.apply(ZEROX96F_SCHEME);
    const afterFirstApply = readFileSync(configPath, "utf8");
    adapter.apply(ZEROX96F_SCHEME);
    const afterSecondApply = readFileSync(configPath, "utf8");

    expect(afterSecondApply).toBe(afterFirstApply);
    expect(countOccurrences(afterSecondApply, "// ch:begin")).toBe(1);
  });

  it("writes a backup of the config before every apply, and undo restores it exactly", () => {
    createOhMyPoshAdapter(configPath, profilePath).apply(ZEROX96F_SCHEME);
    expect(readFileSync(configPath, "utf8")).not.toBe(configFixture);
    expect(readFileSync(`${configPath}.chameleon-backup`, "utf8")).toBe(configFixture);

    undoOhMyPosh(configPath, profilePath);
    expect(readFileSync(configPath, "utf8")).toBe(configFixture);
  });

  it("reloads without touching the config or profile — Oh My Posh's own prompt command re-reads the fixed config path on every render, not this process", () => {
    createOhMyPoshAdapter(configPath, profilePath).reload();
    expect(readFileSync(configPath, "utf8")).toBe(configFixture);
    expect(readFileSync(profilePath, "utf8")).toBe(profileFixture);
  });

  describe("the profile init line (CHM-59)", () => {
    it("writes the one init line naming configPath, never a reload hook", () => {
      createOhMyPoshAdapter(configPath, profilePath).apply(ZEROX96F_SCHEME);

      const resultText = readFileSync(profilePath, "utf8");
      // The user's own profile content is never edited in place — Chameleon's
      // own block is appended, so every original line survives verbatim.
      expect(everyOriginalLineSurvivesInOrder(profileFixture, resultText)).toBe(true);
      expect(resultText).toContain("oh-my-posh init pwsh --config");
      expect(resultText).toContain(configPath);
      // There is nothing left to re-run mid-session — the old design's own
      // reload hook is gone along with the pointer it needed. The user's own,
      // unrelated Set-PoshContext function (see the fixture) still survives —
      // this only asserts Chameleon never wrote a hook redefining it.
      expect(resultText).not.toContain("chameleonPointer");
      expect(usesOnlyLineEnding(resultText, eol)).toBe(true);
    });

    it("is marker-scoped, backed up, and undoable", () => {
      const adapter = createOhMyPoshAdapter(configPath, profilePath);
      adapter.apply(ZEROX96F_SCHEME);

      const resultText = readFileSync(profilePath, "utf8");
      expect(countOccurrences(resultText, "# ch:begin")).toBe(1);
      expect(countOccurrences(resultText, "# ch:end")).toBe(1);
      expect(readFileSync(`${profilePath}.chameleon-backup`, "utf8")).toBe(profileFixture);

      undoOhMyPosh(configPath, profilePath);
      expect(readFileSync(profilePath, "utf8")).toBe(profileFixture);
    });

    it("upserts in place on a second apply — one line, never accumulating", () => {
      const adapter = createOhMyPoshAdapter(configPath, profilePath);
      adapter.apply(ZEROX96F_SCHEME);
      adapter.apply(AARDVARK_BLUE_SCHEME);

      const resultText = readFileSync(profilePath, "utf8");
      expect(countOccurrences(resultText, "# ch:begin")).toBe(1);
      expect(everyOriginalLineSurvivesInOrder(profileFixture, resultText)).toBe(true);
    });

    it("migrates a profile still carrying the old reload hook, replacing it in place rather than leaving both (CHM-59)", () => {
      // Simulates a profile from before this ticket: Chameleon's own marker
      // block, but carrying the old Set-PoshContext hook rather than a plain
      // init line.
      const oldHookBlock = [
        "# ch:begin",
        "function Set-PoshContext {",
        "    oh-my-posh init pwsh --config $chameleonPointer.configPath | Invoke-Expression",
        "}",
        "# ch:end",
      ].join(eol);
      writeFileSync(profilePath, `${profileFixture}${eol}${oldHookBlock}${eol}`, "utf8");

      createOhMyPoshAdapter(configPath, profilePath).apply(ZEROX96F_SCHEME);

      const resultText = readFileSync(profilePath, "utf8");
      expect(countOccurrences(resultText, "# ch:begin")).toBe(1);
      // The old hook's own tell-tale reference is gone — not "Set-PoshContext"
      // itself, which the user's own, unrelated function in the fixture
      // legitimately still carries and must survive untouched.
      expect(resultText).not.toContain("chameleonPointer");
      expect(resultText).toContain("oh-my-posh init pwsh --config");
      expect(everyOriginalLineSurvivesInOrder(profileFixture, resultText)).toBe(true);
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
      const adapter = createOhMyPoshAdapter(configPath, profilePath);
      const layout = addSegment(readOhMyPoshLayout(configPath), "right", 0, buildLayoutSegment("battery", "success"));
      writeOhMyPoshLayout(layout, configPath);

      adapter.apply(ZEROX96F_SCHEME);

      const afterApply = readOhMyPoshLayout(configPath);
      expect(layoutBlocksOnSide(afterApply, "right")[0]?.segments).toEqual([{ type: "battery", foreground: "p:success" }]);
      const parsed = parseWritten(readFileSync(configPath, "utf8")) as { palette: Record<string, string> };
      expect(parsed.palette["success"]).toMatch(/^#[0-9a-f]{6}$/i);
    });

    it("a theme swap survives a later layout edit — apply first, then edit, and the palette holds", () => {
      const adapter = createOhMyPoshAdapter(configPath, profilePath);
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
  let originalChipsText: string;
  let originalPalette: Record<string, string>;

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(tmpdir(), "chameleon-oh-my-posh-chm31-"));
    configPath = path.join(stateDir, "chips.omp.json");
    profilePath = path.join(stateDir, "Microsoft.PowerShell_profile.ps1");
    originalChipsText = readFileSync(CHIPS_FIXTURE_PATH, "utf8");
    originalPalette = (parseWritten(originalChipsText) as { palette: Record<string, string> }).palette;
    writeFileSync(configPath, originalChipsText, "utf8");
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("leaves all 47 of chips's own palette keys defined, recoloured, after applying a theme", () => {
    expect(Object.keys(originalPalette)).toHaveLength(47);

    createOhMyPoshAdapter(configPath, profilePath).apply(ZEROX96F_SCHEME);

    const resultPalette = (parseWritten(readFileSync(configPath, "utf8")) as { palette: Record<string, string> }).palette;
    for (const key of Object.keys(originalPalette)) {
      expect(resultPalette[key]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("adds Chameleon's own six roles alongside chips's keys, never in place of them", () => {
    createOhMyPoshAdapter(configPath, profilePath).apply(ZEROX96F_SCHEME);

    const resultPalette = (parseWritten(readFileSync(configPath, "utf8")) as { palette: Record<string, string> }).palette;
    // At least the original 47 plus Chameleon's six roles — CHM-40 may add
    // further keys of its own, one per segment foreground it had to repair
    // (see "repairs a segment's own foreground..." below), so this is a
    // floor, not an exact count.
    expect(Object.keys(resultPalette).length).toBeGreaterThanOrEqual(47 + ROLES.length);
    for (const key of Object.keys(originalPalette)) {
      expect(resultPalette[key]).toBeDefined();
    }
    for (const role of ROLES) {
      expect(resultPalette[role]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("leaves every segment's own type and background(s) byte-identical, touching only a foreground CHM-40 had to repair", () => {
    const originalBlocks = (parseWritten(originalChipsText) as { blocks: Array<{ segments: Array<Record<string, unknown>> }> }).blocks;
    const originalConsoleTitle = (parseWritten(originalChipsText) as { console_title_template: unknown }).console_title_template;

    createOhMyPoshAdapter(configPath, profilePath).apply(ZEROX96F_SCHEME);

    const resultText = readFileSync(configPath, "utf8");
    const resultParsed = parseWritten(resultText) as {
      blocks: Array<{ segments: Array<Record<string, unknown>> }>;
      console_title_template: unknown;
    };
    expect(resultParsed.console_title_template).toEqual(originalConsoleTitle);
    expect(resultParsed.blocks).toHaveLength(originalBlocks.length);

    // Chips's own "c-badge-text" foreground fails TEXT_MIN_RATIO against a
    // couple of its own error-flavoured backgrounds once recoloured for
    // ZEROX96F — see repair.test.ts's own real-value regression for this
    // exact key. Every OTHER field of every segment — type, background(s),
    // template, options, diamonds — must still come through untouched; only
    // `foreground`/`foreground_templates` may differ, and only where a
    // segment actually needed the fix.
    let repairedSegmentCount = 0;
    originalBlocks.forEach((originalBlock, blockIndex) => {
      const resultBlock = resultParsed.blocks[blockIndex]!;
      expect(resultBlock.segments).toHaveLength(originalBlock.segments.length);
      originalBlock.segments.forEach((originalSegment, segmentIndex) => {
        const resultSegment = resultBlock.segments[segmentIndex]!;
        const { foreground: _originalForeground, foreground_templates: _originalForegroundTemplates, ...originalRest } = originalSegment;
        const { foreground: resultForeground, foreground_templates: resultForegroundTemplates, ...resultRest } = resultSegment;
        expect(resultRest).toEqual(originalRest);

        const wasForegroundRepaired =
          JSON.stringify(resultForeground) !== JSON.stringify(originalSegment["foreground"]) ||
          JSON.stringify(resultForegroundTemplates) !== JSON.stringify(originalSegment["foreground_templates"]);
        if (wasForegroundRepaired) repairedSegmentCount += 1;
      });
    });
    // A test that cannot fail is not a test: this fixture/scheme pair is
    // known (see repair.test.ts) to need at least one repair, so if none
    // happened the repair itself silently stopped running, not that there
    // was nothing to fix.
    expect(repairedSegmentCount).toBeGreaterThan(0);
  });

  it("undoes back to chips's exact original palette", () => {
    createOhMyPoshAdapter(configPath, profilePath).apply(ZEROX96F_SCHEME);
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
      createOhMyPoshAdapter(configPath, profilePath).apply(pack.payloads["windows-terminal"]);

      const resultText = readFileSync(configPath, "utf8");
      const resultPalette = (parseWritten(resultText) as { palette: Record<string, string> }).palette;
      expect(undefinedPaletteReferences(resultText, resultPalette)).toEqual([]);
    }
  });

  it("keeps most of chips's own 47 keys visually distinct after recolouring, across every bundled theme (CHM-37)", () => {
    // CHM-37's own regression: CHM-31 stopped deleting these keys but
    // recoloured nearly all of them to one of Chameleon's six roles, so 46
    // of the 47 collapsed onto three or four colours. chips's own 47 keys
    // already carry only 36 distinct values to start with (several
    // battery/date/wakatime keys are the same colour on purpose) — this
    // asserts recolouring does not destroy meaningfully more of that
    // distinctness than the fixture itself already gives up.
    const originalDistinctCount = new Set(Object.values(originalPalette).map((hex) => hex.toLowerCase())).size;
    const curatedPacks = loadCuratedThemePacks();

    for (const pack of curatedPacks) {
      writeFileSync(configPath, originalChipsText, "utf8");
      createOhMyPoshAdapter(configPath, profilePath).apply(pack.payloads["windows-terminal"]);

      const resultPalette = (parseWritten(readFileSync(configPath, "utf8")) as { palette: Record<string, string> }).palette;
      const recolouredValues = Object.keys(originalPalette).map((key) => resultPalette[key]!.toLowerCase());
      const recolouredDistinctCount = new Set(recolouredValues).size;
      expect(recolouredDistinctCount).toBeGreaterThanOrEqual(originalDistinctCount - 2);
    }
  });

  it("keeps every segment's own foreground legible against its own background, across every bundled theme (CHM-37)", () => {
    // The chips fixture's own failure mode: its "chips" style paints a
    // segment's background from one palette key and its text from another,
    // and CHM-31's flat six-role recolour let both land on the same colour,
    // so the text vanished into its own background. Pairs are extracted
    // from the real fixture's own foreground/background (and their
    // *_templates variants) rather than hand-listed, so this stays correct
    // if the fixture ever changes. This is CHM-37's own distinctness floor
    // (ANSI_MIN_RATIO) — see the next test for CHM-40's stricter, per-segment
    // TEXT_MIN_RATIO floor, checked against what a segment actually renders
    // after CHM-40's own repair, not the shared palette entry alone.
    const pairs = segmentForegroundBackgroundPairs(originalChipsText);
    expect(pairs.length).toBeGreaterThan(0);
    const curatedPacks = loadCuratedThemePacks();

    for (const pack of curatedPacks) {
      writeFileSync(configPath, originalChipsText, "utf8");
      createOhMyPoshAdapter(configPath, profilePath).apply(pack.payloads["windows-terminal"]);

      const resultPalette = (parseWritten(readFileSync(configPath, "utf8")) as { palette: Record<string, string> }).palette;
      for (const [foregroundKey, backgroundKey] of pairs) {
        const contrast = contrastRatio(resultPalette[foregroundKey]!, resultPalette[backgroundKey]!);
        expect(contrast).toBeGreaterThanOrEqual(ANSI_MIN_RATIO);
      }
    }
  });

  it("clears TEXT_MIN_RATIO between every segment's own resolved foreground and background, across every bundled theme (CHM-40)", () => {
    // CHM-37's own verification gap: only chips's "git" segment carries both
    // a plain "foreground" and a plain "background" — every other segment's
    // background only ever shows up in background_templates — so a check
    // that skipped templates ended up sampling exactly one segment and
    // calling that "every segment". segmentsWithResolvablePairCount is what
    // that gap looks like as a number, asserted below so a fixture (or a
    // future check) that regresses back to a one-segment sample fails loudly
    // rather than silently passing on too little coverage again.
    const resolvableSegmentCount = segmentsWithResolvablePairCount(originalChipsText);
    expect(resolvableSegmentCount).toBeGreaterThan(1);

    const curatedPacks = loadCuratedThemePacks();
    let totalPairsChecked = 0;
    let sawAnUnachievableSegment = false;

    for (const pack of curatedPacks) {
      writeFileSync(configPath, originalChipsText, "utf8");
      createOhMyPoshAdapter(configPath, profilePath).apply(pack.payloads["windows-terminal"]);

      // Checked from the RESULT config, not the original — a segment CHM-40
      // had to repair now names a different foreground key than chips
      // shipped with (see repairSegmentForegrounds), and it is that final
      // pairing a real prompt actually renders, not the original one.
      const resultText = readFileSync(configPath, "utf8");
      const resultPalette = (parseWritten(resultText) as { palette: Record<string, string> }).palette;
      const checks = segmentContrastChecks(resultText, resultPalette);
      expect(checks.length).toBeGreaterThanOrEqual(resolvableSegmentCount);

      for (const { segmentType, foregroundKeys, backgroundHexes } of checks) {
        // A segment can mix backgrounds so far apart in luminance — chips's
        // own battery segment pairs several light charge-level pastels with
        // one dark, implied-"error" background — that no single shared
        // foreground can read against every one of them at once (see
        // isSingleForegroundAchievable). CHM-40 still repairs toward the
        // best a single colour can do there, but TEXT_MIN_RATIO itself is
        // only asserted where it is mathematically reachable at all.
        const isAchievable = isSingleForegroundAchievable(backgroundHexes);
        if (!isAchievable) sawAnUnachievableSegment = true;

        for (const foregroundKey of foregroundKeys) {
          const foregroundHex = resultPalette[foregroundKey]!;
          for (const backgroundHex of backgroundHexes) {
            totalPairsChecked += 1;
            const contrast = contrastRatio(foregroundHex, backgroundHex);
            const label = `${pack.manifest.slug} "${segmentType}": ${foregroundKey} (${foregroundHex}) on ${backgroundHex}`;
            if (isAchievable) {
              expect(contrast, label).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
            } else {
              // Even where TEXT_MIN_RATIO itself is unreachable, the repair
              // must still land at least at muted's own, lower floor —
              // never something worse than a de-emphasised colour would be.
              expect(contrast, label).toBeGreaterThanOrEqual(MUTED_MIN_RATIO);
            }
          }
        }
      }
    }

    // The count of pairs actually checked, across every theme — a fixture
    // that silently stopped exercising more than a couple of pairs would
    // still pass an empty loop above without this.
    expect(totalPairsChecked).toBeGreaterThan(resolvableSegmentCount * curatedPacks.length);
    // A test that cannot fail is not a test: chips's own battery/project
    // segments are known (see repair.test.ts) to hit the unreachable case
    // for every light theme, so if this never triggered, the achievability
    // check itself stopped running, not that the case stopped existing.
    expect(sawAnUnachievableSegment).toBe(true);
  });
});

// CHM-57's own reproduction: `ch prompt half-life` switches a bundled layout
// in; a plain createOhMyPoshAdapter().apply() (what every theme apply used to
// call unconditionally) has no idea that happened and recolours a plain
// palette table into Chameleon's owned config, silently reverting the layout
// while prompt-state.json still claims it is active. withActiveLayoutRespected
// is the fix: it wraps an ordinary adapter's own `apply` and, whenever
// prompt-state.json names an active layout, re-resolves that layout into the
// owned config instead of running the palette recolor. Under CHM-59 there is
// only ever the one owned config file — a layout switch and a theme recolor
// both write it, so there is no separate bundled file or pointer left to
// name here.
describe("withActiveLayoutRespected — a theme apply must not clobber an active bundled layout (CHM-57)", () => {
  let stateDir: string;
  let ownedConfigPath: string;
  let profilePath: string;
  let promptStatePath: string;

  function buildAdapter() {
    const baseAdapter = createOhMyPoshAdapter(ownedConfigPath, profilePath);
    return withActiveLayoutRespected(baseAdapter, ownedConfigPath, profilePath, "pwsh", promptStatePath);
  }

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(tmpdir(), "chameleon-oh-my-posh-chm57-"));
    ownedConfigPath = path.join(stateDir, "chameleon.omp.json");
    profilePath = path.join(stateDir, "Microsoft.PowerShell_profile.ps1");
    promptStatePath = path.join(stateDir, "prompt-state.json");
    writeFileSync(ownedConfigPath, JSON.stringify({ palette: { accent: "#ffffff" }, blocks: [] }, null, 2), "utf8");
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("reproduces the ticket's own sequence: apply a layout, then a theme — the owned config still renders the layout, never a plain palette recolor", () => {
    // Simulates `ch prompt half-life` having already run: prompt-state.json
    // records it active.
    writePromptState({ originalConfigPath: ownedConfigPath, activeSlug: "half-life", updatedAtMs: 1 }, promptStatePath);

    buildAdapter().apply(ZEROX96F_SCHEME); // `ch nord-dark`, in the ticket's own words

    const written: unknown = JSON.parse(readFileSync(ownedConfigPath, "utf8"));
    // The layout replaced the owned config wholesale — it no longer carries
    // the plain palette table the fixture started with.
    expect(written).not.toHaveProperty("palette");
  });

  it("recolours the active layout's own p:<role> references to the new theme, not just leaves the config as-is", () => {
    writePromptState({ originalConfigPath: ownedConfigPath, activeSlug: "half-life", updatedAtMs: 1 }, promptStatePath);

    buildAdapter().apply(ZEROX96F_SCHEME);

    const written: unknown = JSON.parse(readFileSync(ownedConfigPath, "utf8"));
    const halfLife = loadBundledPromptPacks().find((candidate) => candidate.manifest.slug === "half-life")!;
    const expected = resolvePromptLayoutRoleReferences(halfLife.layout, resolveRoleHexes(ZEROX96F_SCHEME));
    expect(written).toEqual(expected);
    expect(JSON.stringify(written)).not.toContain("p:");
  });

  it("recolours the active layout for every one of the 26 bundled themes, leaving it active every time", () => {
    writePromptState({ originalConfigPath: ownedConfigPath, activeSlug: "spaceship", updatedAtMs: 1 }, promptStatePath);
    const adapter = buildAdapter();
    const curatedPacks = loadCuratedThemePacks();
    expect(curatedPacks.length).toBe(26);

    for (const pack of curatedPacks) {
      adapter.apply(pack.payloads["windows-terminal"]);

      const written = JSON.stringify(JSON.parse(readFileSync(ownedConfigPath, "utf8")));
      expect(written).not.toContain("p:");
    }
  });

  it("falls back to the ordinary config-swap path once no layout is active — 'mine' is untouched by this fix", () => {
    // A real init line already names ownedConfigPath, so the very first
    // seeding call finds it rather than needing to discover anything else.
    writeFileSync(profilePath, `oh-my-posh init pwsh --config '${ownedConfigPath}' | Invoke-Expression\n`, "utf8");

    buildAdapter().apply(ZEROX96F_SCHEME);

    const parsed = parseWritten(readFileSync(ownedConfigPath, "utf8")) as { palette: Record<string, string> };
    expect(parsed.palette["accent"]).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("falls back to the ordinary config-swap path once `ch prompt mine` cleared the active slug", () => {
    writePromptState({ originalConfigPath: ownedConfigPath, activeSlug: undefined, updatedAtMs: 1 }, promptStatePath);

    buildAdapter().apply(ZEROX96F_SCHEME);

    const parsed = parseWritten(readFileSync(ownedConfigPath, "utf8")) as { palette: Record<string, string> };
    expect(parsed.palette["accent"]).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe("repeated applies converge instead of compounding (CHM-43)", () => {
  let stateDir: string;
  let configPath: string;
  let profilePath: string;
  let originalChipsText: string;
  let originalPaletteKeys: string[];

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(tmpdir(), "chameleon-oh-my-posh-chm43-"));
    configPath = path.join(stateDir, "chips.omp.json");
    profilePath = path.join(stateDir, "Microsoft.PowerShell_profile.ps1");
    originalChipsText = readFileSync(CHIPS_FIXTURE_PATH, "utf8");
    originalPaletteKeys = Object.keys((parseWritten(originalChipsText) as { palette: Record<string, string> }).palette);
    writeFileSync(configPath, originalChipsText, "utf8");
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("leaves the palette key count identical after a second full pass through all 26 bundled themes — applied repeatedly, not once", () => {
    // The bug this ticket exists to fix only shows up on repeated applies —
    // the reporter's own measurement went from 47 keys to 418 after "a
    // handful of applies", never converging. Verified against the
    // reporter's real 47-key config (chips.omp.json, CHM-16's own fixture),
    // cycled through every bundled theme twice: a fixture applied once, the
    // way every other test in this file exercises it, is exactly what hid
    // this bug in the first place.
    const curatedPacks = loadCuratedThemePacks();
    expect(curatedPacks.length).toBe(26);
    const adapter = createOhMyPoshAdapter(configPath, profilePath);

    for (const pack of curatedPacks) {
      adapter.apply(pack.payloads["windows-terminal"]);
    }
    const keyCountAfterFirstPass = Object.keys(
      (parseWritten(readFileSync(configPath, "utf8")) as { palette: Record<string, string> }).palette,
    ).length;

    for (const pack of curatedPacks) {
      adapter.apply(pack.payloads["windows-terminal"]);
    }
    const keyCountAfterSecondPass = Object.keys(
      (parseWritten(readFileSync(configPath, "utf8")) as { palette: Record<string, string> }).palette,
    ).length;

    expect(keyCountAfterSecondPass).toBe(keyCountAfterFirstPass);
  });

  it("never mints a key name that carries -legible more than once, across two full passes", () => {
    const curatedPacks = loadCuratedThemePacks();
    const adapter = createOhMyPoshAdapter(configPath, profilePath);

    for (const pack of [...curatedPacks, ...curatedPacks]) {
      adapter.apply(pack.payloads["windows-terminal"]);
    }

    const finalPalette = (parseWritten(readFileSync(configPath, "utf8")) as { palette: Record<string, string> }).palette;
    for (const key of Object.keys(finalPalette)) {
      expect(countOccurrences(key, "legible")).toBeLessThanOrEqual(1);
    }
  });

  it("leaves no generated key that no segment references, across two full passes", () => {
    const curatedPacks = loadCuratedThemePacks();
    const adapter = createOhMyPoshAdapter(configPath, profilePath);

    for (const pack of [...curatedPacks, ...curatedPacks]) {
      adapter.apply(pack.payloads["windows-terminal"]);
    }

    const resultText = readFileSync(configPath, "utf8");
    const finalPalette = (parseWritten(resultText) as { palette: Record<string, string> }).palette;
    const referencedKeys = everyReferencedPaletteKey(resultText);
    const generatedKeys = Object.keys(finalPalette).filter((key) => key.includes("legible"));
    // A test that cannot fail is not a test: this scheme/fixture pair is
    // known (see the CHM-40 tests above) to need at least one repair, so an
    // empty generatedKeys here would mean the repair itself stopped running.
    expect(generatedKeys.length).toBeGreaterThan(0);
    for (const key of generatedKeys) {
      expect(referencedKeys.has(key)).toBe(true);
    }
  });

  it("keeps every one of chips's own original 47 keys defined after two full passes, never dropping one (CHM-31)", () => {
    const curatedPacks = loadCuratedThemePacks();
    const adapter = createOhMyPoshAdapter(configPath, profilePath);
    expect(originalPaletteKeys).toHaveLength(47);

    for (const pack of [...curatedPacks, ...curatedPacks]) {
      adapter.apply(pack.payloads["windows-terminal"]);
    }

    const finalPalette = (parseWritten(readFileSync(configPath, "utf8")) as { palette: Record<string, string> }).palette;
    for (const key of originalPaletteKeys) {
      expect(finalPalette[key]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("clears TEXT_MIN_RATIO between every segment's own resolved foreground and background after two full passes (CHM-40)", () => {
    const curatedPacks = loadCuratedThemePacks();
    const adapter = createOhMyPoshAdapter(configPath, profilePath);

    for (const pack of [...curatedPacks, ...curatedPacks]) {
      adapter.apply(pack.payloads["windows-terminal"]);
    }

    const resultText = readFileSync(configPath, "utf8");
    const resultPalette = (parseWritten(resultText) as { palette: Record<string, string> }).palette;
    const checks = segmentContrastChecks(resultText, resultPalette);
    expect(checks.length).toBeGreaterThan(0);

    for (const { foregroundKeys, backgroundHexes } of checks) {
      const isAchievable = isSingleForegroundAchievable(backgroundHexes);
      for (const foregroundKey of foregroundKeys) {
        const foregroundHex = resultPalette[foregroundKey]!;
        for (const backgroundHex of backgroundHexes) {
          const contrast = contrastRatio(foregroundHex, backgroundHex);
          expect(contrast).toBeGreaterThanOrEqual(isAchievable ? TEXT_MIN_RATIO : MUTED_MIN_RATIO);
        }
      }
    }
  });
});

/** `pack.manifest.slug === slug`'s own scheme payload — the fixture data every CHM-53 test below applies chips against, looked up by name rather than array position so a reordering of themes/ never silently swaps which pack a test means. */
function schemeForSlug(curatedPacks: readonly ThemePack[], slug: string): Scheme {
  const pack = curatedPacks.find((candidate) => candidate.manifest.slug === slug);
  if (!pack) throw new Error(`no bundled pack named "${slug}" — has themes/ been renamed?`);
  return pack.payloads["windows-terminal"];
}

/** The mean rgbDistance between `paletteA` and `paletteB`, over every key present in both — the "how far apart do these two renders actually look" measure CHM-53's own bug report needs: a single key could coincidentally repeat under two themes even when the mapping is working, but the config as a whole should not. */
function meanRgbDistanceOverSharedKeys(paletteA: Readonly<Record<string, string>>, paletteB: Readonly<Record<string, string>>): number {
  const sharedKeys = Object.keys(paletteA).filter((key) => paletteB[key] !== undefined);
  const distances = sharedKeys.map((key) => rgbDistance(paletteA[key]!, paletteB[key]!));
  return distances.reduce((total, distance) => total + distance, 0) / distances.length;
}

// The minimum mean rgbDistance (see color.ts) two unrelated destination
// packs' own renders of the same 47-key config must clear — chosen well
// above the 2-3 RGB units the ticket's own bug report measured, and shared
// by every pairwise comparison below so the floor cannot quietly drift
// between them.
const MIN_MEAN_CROSS_THEME_RGB_DISTANCE = 30;

describe("recolouring reflects the destination theme, not the source (CHM-53)", () => {
  let stateDir: string;
  let configPath: string;
  let profilePath: string;
  let originalChipsText: string;
  let originalPaletteKeys: string[];

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(tmpdir(), "chameleon-oh-my-posh-chm53-"));
    configPath = path.join(stateDir, "chips.omp.json");
    profilePath = path.join(stateDir, "Microsoft.PowerShell_profile.ps1");
    originalChipsText = readFileSync(CHIPS_FIXTURE_PATH, "utf8");
    originalPaletteKeys = Object.keys((parseWritten(originalChipsText) as { palette: Record<string, string> }).palette);
    writeFileSync(configPath, originalChipsText, "utf8");
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  /** Recolours the pristine chips fixture under `scheme` and returns just the original 47 keys' resolved hexes — never a "-legible" override CHM-40 minted only for one of the two themes being compared, which would not be a shared key at all. */
  function recolouredOriginalKeys(scheme: Scheme): Record<string, string> {
    writeFileSync(configPath, originalChipsText, "utf8");
    createOhMyPoshAdapter(configPath, profilePath).apply(scheme);
    const resultPalette = (parseWritten(readFileSync(configPath, "utf8")) as { palette: Record<string, string> }).palette;
    return Object.fromEntries(originalPaletteKeys.map((key) => [key, resultPalette[key]!]));
  }

  it("renders chips's own 47 keys far apart between Dracula and Nord — not the 2-3 RGB-unit nudge CHM-53 exists to fix", () => {
    // The ticket's own measured regression: four unrelated destination packs
    // (nord-dark, dracula-dark, gruvbox-light, everforest-dark) rendered the
    // reporter's Solarized-derived config as the same olive/gold/blue,
    // moving only 2-3 RGB units. Dracula (pink/purple) and Nord (a muted
    // blue-grey) share nothing, so a real fix must move the *whole config*,
    // not one hand-picked key, by far more than that.
    const curatedPacks = loadCuratedThemePacks();
    const draculaPalette = recolouredOriginalKeys(schemeForSlug(curatedPacks, "dracula-dark"));
    const nordPalette = recolouredOriginalKeys(schemeForSlug(curatedPacks, "nord-dark"));

    expect(meanRgbDistanceOverSharedKeys(draculaPalette, nordPalette)).toBeGreaterThanOrEqual(MIN_MEAN_CROSS_THEME_RGB_DISTANCE);
  });

  it("renders chips's own 47 keys far apart across three unrelated destination packs, not just a light/dark pair of the same family", () => {
    // The ticket's own warning: Solarized Light vs Solarized Dark would pass
    // a naive distance check for the wrong reason — they share accent
    // colours and differ mainly in ground. Dracula, Nord and Gruvbox share
    // no family with each other, so every pair among the three must clear
    // the same floor as the Dracula/Nord pair above.
    const curatedPacks = loadCuratedThemePacks();
    const draculaPalette = recolouredOriginalKeys(schemeForSlug(curatedPacks, "dracula-dark"));
    const nordPalette = recolouredOriginalKeys(schemeForSlug(curatedPacks, "nord-dark"));
    const gruvboxPalette = recolouredOriginalKeys(schemeForSlug(curatedPacks, "gruvbox-light"));

    expect(meanRgbDistanceOverSharedKeys(draculaPalette, nordPalette)).toBeGreaterThanOrEqual(MIN_MEAN_CROSS_THEME_RGB_DISTANCE);
    expect(meanRgbDistanceOverSharedKeys(draculaPalette, gruvboxPalette)).toBeGreaterThanOrEqual(MIN_MEAN_CROSS_THEME_RGB_DISTANCE);
    expect(meanRgbDistanceOverSharedKeys(nordPalette, gruvboxPalette)).toBeGreaterThanOrEqual(MIN_MEAN_CROSS_THEME_RGB_DISTANCE);
  });
});

// CHM-27: this is the exact comparison `ch current`/`ch doctor` use to
// notice a target that has drifted from the recorded pack.
describe("ohMyPoshMatchesRoleHexes", () => {
  let stateDir: string;
  let configPath: string;
  let profilePath: string;

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(tmpdir(), "chameleon-oh-my-posh-drift-"));
    configPath = path.join(stateDir, "theme.omp.json");
    profilePath = path.join(stateDir, "Microsoft.PowerShell_profile.ps1");
    writeFileSync(configPath, LF_CONFIG_FIXTURE, "utf8");
    writeFileSync(profilePath, LF_PROFILE_FIXTURE, "utf8");
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("matches right after apply", () => {
    const adapter = createOhMyPoshAdapter(configPath, profilePath);
    adapter.apply(ZEROX96F_SCHEME);

    expect(ohMyPoshMatchesRoleHexes(adapter.read(), resolveRoleHexes(ZEROX96F_SCHEME))).toBe(true);
  });

  it("does not match a scheme other than the one last applied", () => {
    const adapter = createOhMyPoshAdapter(configPath, profilePath);
    adapter.apply(ZEROX96F_SCHEME);

    expect(ohMyPoshMatchesRoleHexes(adapter.read(), resolveRoleHexes(AARDVARK_BLUE_SCHEME))).toBe(false);
  });

  it("does not match a config that was never themed by Chameleon at all", () => {
    const config = createOhMyPoshAdapter(configPath, profilePath).read();

    expect(ohMyPoshMatchesRoleHexes(config, resolveRoleHexes(ZEROX96F_SCHEME))).toBe(false);
  });
});

describe("oh my posh adapter — edge cases", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(tmpdir(), "chameleon-oh-my-posh-edge-"));
    // Never trust whatever the machine actually running these tests happens
    // to have exported — a dev box with Oh My Posh live in the same shell
    // running `npm test` would otherwise make this suite pass or fail
    // depending on what shell it happened to be run from. See CHM-36: the
    // bug this file exists to catch survived exactly because every earlier
    // version of this test exported the variable it was meant to discover.
    vi.stubEnv("POSH_CONFIG", "");
    vi.stubEnv("POSH_THEME", "");
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("names the file and the problem when a config it must edit is shaped wrong", () => {
    const malformedPath = path.join(stateDir, "malformed.omp.json");
    writeFileSync(malformedPath, JSON.stringify({ palette: "not an object" }), "utf8");
    expect(() => createOhMyPoshAdapter(malformedPath, path.join(stateDir, "profile.ps1")).read()).toThrow(malformedPath);
  });

  it("names everything it tried — not just POSH_THEME — when no config can be discovered anywhere, env or profile (CHM-36)", () => {
    // A real fixture profile with no oh-my-posh init line at all, not an
    // absent file and not the host's own real profile — CHM-36's own
    // complaint about the previous version of this test was that it "also
    // depends on the host machine having no usable Oh My Posh profile,
    // which makes it environment-dependent." This one does not. Discovery
    // now lives in ensureOhMyPoshOwnedConfigSeeded, the seeding step every
    // real apply runs before the very first theme or layout switch.
    const profilePath = path.join(stateDir, "profile.ps1");
    writeFileSync(profilePath, "Set-Alias ll Get-ChildItem\n", "utf8");
    const ownedConfigPath = path.join(stateDir, "chameleon.omp.json");
    const promptStatePath = path.join(stateDir, "prompt-state.json");

    const seed = () => ensureOhMyPoshOwnedConfigSeeded(ownedConfigPath, profilePath, "pwsh", promptStatePath);
    expect(seed).toThrow(/POSH_CONFIG/);
    expect(seed).toThrow(/POSH_THEME/);
    expect(seed).toThrow(profilePath);
  });

  it("refuses to apply when there is no config at the given path", () => {
    const adapter = createOhMyPoshAdapter(path.join(stateDir, "missing.omp.json"), path.join(stateDir, "profile.ps1"));
    expect(() => adapter.apply(ZEROX96F_SCHEME)).toThrow();
  });

  it("creates the profile when none exists yet, rather than failing", () => {
    const configPath = path.join(stateDir, "theme.omp.json");
    writeFileSync(configPath, JSON.stringify({ blocks: [] }), "utf8");
    const profilePath = path.join(stateDir, "nested", "Microsoft.PowerShell_profile.ps1");

    createOhMyPoshAdapter(configPath, profilePath).apply(ZEROX96F_SCHEME);

    const resultText = readFileSync(profilePath, "utf8");
    expect(resultText).toContain("oh-my-posh init pwsh --config");
    expect(resultText).not.toMatch(/,\s*[\]}]/);
  });

  it("never leaves a dangling comma when palette starts out missing entirely", () => {
    const configPath = path.join(stateDir, "theme.omp.json");
    writeFileSync(configPath, JSON.stringify({ blocks: [] }), "utf8");
    const profilePath = path.join(stateDir, "profile.ps1");

    createOhMyPoshAdapter(configPath, profilePath).apply(ZEROX96F_SCHEME);

    const resultText = readFileSync(configPath, "utf8");
    const parsed = parseWritten(resultText) as { palette: Record<string, string> };
    expect(parsed.palette["accent"]).toMatch(/^#[0-9a-f]{6}$/i);
    expect(resultText).not.toMatch(/,\s*[\]}]/);
  });
});

// CHM-25: Oh My Posh's live reload worked only from PowerShell — the
// Set-PoshContext hook was written into a PowerShell profile regardless of
// which shell `ch` was actually run from. Under CHM-59 there is no reload
// hook left at all for pwsh/bash/zsh — just the one `oh-my-posh init <shell>
// --config` line, in each shell's own rc file. cmd.exe still has no rc file
// of its own, so its "profile" is a Clink Lua script instead, and Chameleon
// still refuses to write one when Clink itself is not on PATH rather than
// silently doing nothing.
describe("shell-specific profile lines (CHM-25, CHM-59)", () => {
  let stateDir: string;
  let configPath: string;

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(tmpdir(), "chameleon-oh-my-posh-shells-"));
    configPath = path.join(stateDir, "theme.omp.json");
    writeFileSync(configPath, LF_CONFIG_FIXTURE, "utf8");
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("writes a plain init line into bash's own rc file, chaining nothing", () => {
    const profilePath = path.join(stateDir, ".bashrc");
    writeFileSync(profilePath, 'export EDITOR="nvim"\n', "utf8");

    createOhMyPoshAdapter(configPath, profilePath, "bash").apply(ZEROX96F_SCHEME);

    const resultText = readFileSync(profilePath, "utf8");
    expect(resultText).toContain('export EDITOR="nvim"'); // the user's own line survives untouched
    expect(resultText).toContain("oh-my-posh init bash");
    expect(resultText).toContain(configPath);
    // Nothing left to re-run mid-session — no precmd hook of Chameleon's own.
    expect(resultText).not.toContain("PROMPT_COMMAND");
  });

  it("writes a plain init line into zsh's own rc file", () => {
    const profilePath = path.join(stateDir, ".zshrc");
    writeFileSync(profilePath, "", "utf8");

    createOhMyPoshAdapter(configPath, profilePath, "zsh").apply(ZEROX96F_SCHEME);

    const resultText = readFileSync(profilePath, "utf8");
    expect(resultText).toContain("oh-my-posh init zsh");
    expect(resultText).toContain(configPath);
    expect(resultText).not.toContain("precmd_functions");
  });

  it("re-applying replaces its own bash line in place rather than duplicating it", () => {
    const profilePath = path.join(stateDir, ".bashrc");
    writeFileSync(profilePath, "", "utf8");
    const adapter = createOhMyPoshAdapter(configPath, profilePath, "bash");

    adapter.apply(ZEROX96F_SCHEME);
    adapter.apply(ZEROX96F_SCHEME);

    const occurrences = readFileSync(profilePath, "utf8").split("oh-my-posh init bash").length - 1;
    expect(occurrences).toBe(1);
  });

  it("refuses cmd.exe's Clink script plainly when Clink is not installed, rather than skipping it silently", () => {
    const profilePath = path.join(stateDir, "chameleon-oh-my-posh.lua");
    vi.mocked(spawnSync).mockReturnValueOnce(makeSpawnResult({ error: new Error("ENOENT"), status: null }));

    expect(() => createOhMyPoshAdapter(configPath, profilePath, "cmd").apply(ZEROX96F_SCHEME)).toThrow(/Clink/);
  });

  it("writes a Clink prompt-filter script naming the fixed config path when Clink is installed", () => {
    const profilePath = path.join(stateDir, "chameleon-oh-my-posh.lua");
    vi.mocked(spawnSync).mockReturnValueOnce(makeSpawnResult({ status: 0, stdout: "1.6.5" }));

    createOhMyPoshAdapter(configPath, profilePath, "cmd").apply(ZEROX96F_SCHEME);

    const resultText = readFileSync(profilePath, "utf8");
    expect(resultText).toContain("clink.promptfilter");
    expect(resultText).toContain("oh-my-posh print primary");
    expect(resultText).toContain("-- ch:begin");
  });
});

// CHM-39: a hook written to a profile file nothing loads is silent breakage
// — the bug this ticket exists to fix was Chameleon creating exactly that
// kind of orphan file without ever saying so. `apply`'s own return value is
// the one place left to say it: undefined when the profile already existed,
// a one-sentence notice naming the path when `apply` had to create it.
describe("profile-creation notice (CHM-39)", () => {
  let stateDir: string;
  let configPath: string;

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(tmpdir(), "chameleon-oh-my-posh-profile-notice-"));
    configPath = path.join(stateDir, "theme.omp.json");
    writeFileSync(configPath, LF_CONFIG_FIXTURE, "utf8");
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("names the path and the reason when the profile did not exist before apply", () => {
    // Nested and never created ahead of time — apply must create every
    // missing parent directory itself, the same as backupBeforeEdit already
    // does for the config.
    const profilePath = path.join(stateDir, "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1");

    const notice = createOhMyPoshAdapter(configPath, profilePath).apply(ZEROX96F_SCHEME);

    expect(notice).toContain(profilePath);
    expect(existsSync(profilePath)).toBe(true);
  });

  it("returns undefined — nothing new to say — when the profile already existed", () => {
    const profilePath = path.join(stateDir, "profile.ps1");
    writeFileSync(profilePath, "", "utf8");

    const notice = createOhMyPoshAdapter(configPath, profilePath).apply(ZEROX96F_SCHEME);

    expect(notice).toBeUndefined();
  });
});

// CHM-36: current Oh My Posh (31.x) sets POSH_CONFIG, not POSH_THEME, and a
// normal shell that simply has not run `oh-my-posh init` yet this session —
// the state every freshly opened, genuinely configured shell starts in —
// has neither set at all. This is the fallback that makes the very first
// theme or layout switch still find the user's own config then: parsing the
// profile's own init line for the --config argument it already carries, the
// same path Oh My Posh itself would read. Under CHM-59 this discovery runs
// once, inside ensureOhMyPoshOwnedConfigSeeded, rather than on every apply.
describe("profile-parsing fallback when neither POSH_CONFIG nor POSH_THEME is set (CHM-36)", () => {
  let stateDir: string;
  let ownedConfigPath: string;
  let promptStatePath: string;

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(tmpdir(), "chameleon-oh-my-posh-fallback-"));
    ownedConfigPath = path.join(stateDir, "chameleon.omp.json");
    promptStatePath = path.join(stateDir, "prompt-state.json");
    vi.stubEnv("POSH_CONFIG", "");
    vi.stubEnv("POSH_THEME", "");
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  /** Writes the ordinary config fixture at `configPath`, creating its parent directory first — the file a --config argument found in a profile is meant to resolve to. */
  function writeTargetConfig(configPath: string): void {
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, LF_CONFIG_FIXTURE, "utf8");
  }

  it("resolves a pwsh init line that routes the binary through a variable, expanding $env: in the --config path", () => {
    // The reporter's own profile: the binary is never named "oh-my-posh"
    // literally, and the --config path carries a $env: reference — the two
    // things the first attempt at this fix missed.
    const fakeUserProfile = path.join(stateDir, "home");
    const targetConfigPath = path.join(fakeUserProfile, ".config", "oh-my-posh", "chips-solarized-light.omp.json");
    writeTargetConfig(targetConfigPath);
    vi.stubEnv("USERPROFILE", fakeUserProfile);

    const profilePath = path.join(stateDir, "profile.ps1");
    writeFileSync(
      profilePath,
      [
        String.raw`$ohMyPoshExe = "$env:LOCALAPPDATA\Programs\oh-my-posh\bin\oh-my-posh.exe"`,
        String.raw`& $ohMyPoshExe init pwsh --config "$env:USERPROFILE\.config\oh-my-posh\chips-solarized-light.omp.json" | Invoke-Expression`,
      ].join("\n"),
      "utf8",
    );

    const discovered = ensureOhMyPoshOwnedConfigSeeded(ownedConfigPath, profilePath, "pwsh", promptStatePath);

    expect(path.normalize(discovered)).toBe(path.normalize(targetConfigPath));
    expect(readFileSync(ownedConfigPath, "utf8")).toBe(LF_CONFIG_FIXTURE);
  });

  it("resolves a plain 'oh-my-posh init pwsh --config' line naming the binary literally", () => {
    const targetConfigPath = path.join(stateDir, "theme.omp.json");
    writeTargetConfig(targetConfigPath);
    const profilePath = path.join(stateDir, "profile.ps1");
    writeFileSync(profilePath, `oh-my-posh init pwsh --config '${targetConfigPath}' | Invoke-Expression\n`, "utf8");

    const discovered = ensureOhMyPoshOwnedConfigSeeded(ownedConfigPath, profilePath, "pwsh", promptStatePath);

    expect(path.normalize(discovered)).toBe(path.normalize(targetConfigPath));
  });

  it("resolves a bash init line, expanding $HOME in an unquoted --config path", () => {
    const fakeHome = path.join(stateDir, "home");
    const targetConfigPath = path.join(fakeHome, ".poshthemes", "theme.omp.json");
    writeTargetConfig(targetConfigPath);
    vi.stubEnv("HOME", fakeHome);

    const profilePath = path.join(stateDir, ".bashrc");
    // Genuinely unquoted, and butted right up against the eval's own
    // closing `)"` with no space — the shape that broke a naive `\S+`
    // capture during review.
    writeFileSync(profilePath, 'eval "$(oh-my-posh init bash --config $HOME/.poshthemes/theme.omp.json)"\n', "utf8");

    const discovered = ensureOhMyPoshOwnedConfigSeeded(ownedConfigPath, profilePath, "bash", promptStatePath);

    expect(path.normalize(discovered)).toBe(path.normalize(targetConfigPath));
  });

  it("resolves a zsh init line, expanding a leading ~ in an unquoted --config path", () => {
    const fakeHome = path.join(stateDir, "home");
    const targetConfigPath = path.join(fakeHome, ".cache", "oh-my-posh", "theme.omp.json");
    writeTargetConfig(targetConfigPath);
    // Node's own os.homedir() consults $HOME on POSIX and %USERPROFILE% on
    // Windows — stubbing both is what makes this deterministic on either.
    vi.stubEnv("HOME", fakeHome);
    vi.stubEnv("USERPROFILE", fakeHome);

    const profilePath = path.join(stateDir, ".zshrc");
    writeFileSync(profilePath, 'eval "$(oh-my-posh init zsh --config ~/.cache/oh-my-posh/theme.omp.json)"\n', "utf8");

    const discovered = ensureOhMyPoshOwnedConfigSeeded(ownedConfigPath, profilePath, "zsh", promptStatePath);

    expect(path.normalize(discovered)).toBe(path.normalize(targetConfigPath));
  });

  it("never falls back to the profile once POSH_CONFIG (or POSH_THEME) is actually set — the environment wins", () => {
    const envConfigPath = path.join(stateDir, "env-theme.omp.json");
    writeTargetConfig(envConfigPath);
    const profileConfigPath = path.join(stateDir, "profile-theme.omp.json");
    writeTargetConfig(profileConfigPath);
    const profilePath = path.join(stateDir, "profile.ps1");
    writeFileSync(profilePath, `oh-my-posh init pwsh --config '${profileConfigPath}' | Invoke-Expression\n`, "utf8");
    vi.stubEnv("POSH_CONFIG", envConfigPath);

    const discovered = ensureOhMyPoshOwnedConfigSeeded(ownedConfigPath, profilePath, "pwsh", promptStatePath);

    expect(discovered).toBe(envConfigPath);
    expect(readFileSync(profileConfigPath, "utf8")).toBe(LF_CONFIG_FIXTURE);
  });

  it("finds nothing in a profile whose only init line is for a different shell", () => {
    const profilePath = path.join(stateDir, "profile.ps1");
    writeFileSync(profilePath, `oh-my-posh init pwsh --config '${path.join(stateDir, "theme.omp.json")}' | Invoke-Expression\n`, "utf8");

    expect(() => ensureOhMyPoshOwnedConfigSeeded(ownedConfigPath, profilePath, "bash", promptStatePath)).toThrow(/POSH_CONFIG/);
  });

  // CHM-39: Chameleon's own reload hook used to contain the literal text
  // "oh-my-posh init pwsh --config $chameleonPointer.configPath" — which
  // matched this exact fallback's own pattern and got read back as if it
  // were the user's config path. Under CHM-59 there is no separate hook, but
  // the profile's own single init line (naming ownedConfigPath) must be
  // excluded from discovery the same way — see withoutOwnedMarkerBlocks.
  it("never reads its own marker-scoped init line back as the user's config", () => {
    const firstAppliedConfigPath = path.join(stateDir, "first-applied.omp.json");
    writeTargetConfig(firstAppliedConfigPath);
    const profilePath = path.join(stateDir, "profile.ps1");
    writeFileSync(profilePath, "", "utf8");

    // configPath is given directly here, so the profile fallback is never
    // consulted — this step only exists to write Chameleon's own marker
    // block into the profile, the same as a real `ch apply` would.
    createOhMyPoshAdapter(firstAppliedConfigPath, profilePath).apply(ZEROX96F_SCHEME);
    expect(readFileSync(profilePath, "utf8")).toContain(firstAppliedConfigPath);

    // A later run with neither POSH_CONFIG nor POSH_THEME set (a fresh
    // shell) must fall back to parsing the same profile, and must find
    // nothing — Chameleon's own marker-scoped line is excluded.
    expect(() => ensureOhMyPoshOwnedConfigSeeded(ownedConfigPath, profilePath, "pwsh", promptStatePath)).toThrow(/POSH_CONFIG/);
  });

  it("still resolves a real user init line that sits outside Chameleon's own marker block", () => {
    const realConfigPath = path.join(stateDir, "user-theme.omp.json");
    writeTargetConfig(realConfigPath);
    const firstAppliedConfigPath = path.join(stateDir, "first-applied.omp.json");
    writeTargetConfig(firstAppliedConfigPath);
    const profilePath = path.join(stateDir, "profile.ps1");
    writeFileSync(profilePath, `oh-my-posh init pwsh --config '${realConfigPath}' | Invoke-Expression\n`, "utf8");

    // Appends Chameleon's own marker block underneath the user's real line —
    // the profile now carries two lines that could plausibly match.
    createOhMyPoshAdapter(firstAppliedConfigPath, profilePath).apply(ZEROX96F_SCHEME);

    const discovered = ensureOhMyPoshOwnedConfigSeeded(ownedConfigPath, profilePath, "pwsh", promptStatePath);

    expect(discovered).toBe(realConfigPath);
  });
});

// CHM-54: createDefaultOhMyPoshAdapter() resolves pwsh's own profile path via
// ohMyPoshProfilePathFor, which used to probe which PowerShell edition is
// installed and where Documents really is (OneDrive redirection, CHM-39) by
// spawning a process on every single call — a cold PowerShell start costs on
// the order of 100ms, and this factory is called twice per theme change
// (detect, then apply). Neither answer can change while `ch` is running, so
// platform.ts now memoizes both for the process's lifetime — see
// resetPlatformProbeCache.

/** CHM-54's own acceptance number for a memoized (second-or-later) construction. */
const MEMOIZED_CALL_BUDGET_MS = 5;

describe("createDefaultOhMyPoshAdapter performance (CHM-54)", () => {
  beforeEach(() => {
    resetPlatformProbeCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(spawnSync).mockReset();
    resetPlatformProbeCache();
  });

  it("costs under 5ms on a second call in the same process, once the first has already paid the real cost", () => {
    // ohMyPoshProfilePathFor only reaches the probed paths for pwsh on
    // Windows — everywhere else (and every other shell) resolves from env
    // vars alone, which was never the slow part. See CHM-25.
    if (!isWindows()) return;
    vi.stubEnv("PSModulePath", String.raw`C:\Program Files\PowerShell\Modules`);

    // spawnSync itself blocks Node's event loop synchronously, so a mock
    // standing in for a real PowerShell/registry spawn has to block the
    // same way to reproduce CHM-54's actual cost — a plain mockReturnValue
    // returns instantly and would prove nothing about the fix. This keeps
    // the assertion deterministic across CI hosts, rather than depending on
    // how long a real "powershell"/"reg" happens to take on whichever
    // machine the suite runs on.
    const SIMULATED_SPAWN_LATENCY_MS = 20;
    vi.mocked(spawnSync).mockImplementation(() => {
      const deadline = Date.now() + SIMULATED_SPAWN_LATENCY_MS;
      while (Date.now() < deadline) {
        // Busy-wait: see the comment above for why this can't just await.
      }
      return makeSpawnResult({ error: new Error("ENOENT"), status: null });
    });

    createDefaultOhMyPoshAdapter();
    const spawnCallsAfterFirstConstruction = vi.mocked(spawnSync).mock.calls.length;
    expect(spawnCallsAfterFirstConstruction).toBeGreaterThan(0);

    const secondCallStart = Date.now();
    createDefaultOhMyPoshAdapter();
    const secondCallDurationMs = Date.now() - secondCallStart;

    expect(secondCallDurationMs).toBeLessThan(MEMOIZED_CALL_BUDGET_MS);
    // No new spawn at all — every probe the second construction needed was
    // already memoized by the first.
    expect(vi.mocked(spawnSync).mock.calls.length).toBe(spawnCallsAfterFirstConstruction);
  });
});
