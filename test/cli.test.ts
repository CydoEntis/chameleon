import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentPackReport, LoadedThemePack, PackActionResult } from "../src/index.js";
import { loadCuratedThemePacks, mergeThemePacksBySlug } from "../src/index.js";
import { relativeLuminance } from "../src/palette/color.js";
import {
  buildTerminalPreviewSequence,
  buildTerminalResetSequence,
  createSettledFileTargetPreview,
  formatClaudeCodeRestartNote,
  formatDriftLine,
  formatLockHeldMessage,
  formatNoteworthyResultLines,
  formatPreviewInProgressLine,
  formatThemeLine,
  hasDrift,
  normalizeThemeQuery,
  type PickerEntry,
  renderPickerFrame,
  renderPickerRow,
  resolveThemeQuery,
  shouldRestoreOriginalSelectionOnExit,
  toPickerEntry,
  USAGE,
  wantsPlainThemeList,
} from "../src/cli.js";

/** The same 24-bit SGR escape renderPickerRow emits — sgrBase 38 for foreground, 48 for background — built independently here so the test proves the row carries the pack's own channel values, not just some escape sequence. */
function sgrColorEscape(sgrBase: 38 | 48, hex: string): string {
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  return `\x1b[${sgrBase};2;${red};${green};${blue}m`;
}

const SGR_REVERSE_VIDEO = "\x1b[7m";

/** Every SGR escape renderPickerRow/renderPickerFrame can emit, stripped away — CHM-66's own column and width acceptance criteria are stated "measured excluding escape sequences", so every such assertion goes through this rather than counting raw characters. */
function stripAnsiEscapes(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

// CHM-34: `ch doctor` was reporting "drift: none" — a comparison it never
// performed — whenever the recorded pack could no longer be loaded (deleted
// after being applied). `driftedTargets` comes back empty in that case for
// the same reason it comes back empty on a genuine match (see
// currentPack/detectPackDrift in index.pack-commands.test.ts), so
// formatDriftLine/hasDrift must branch on `name === undefined`, not just on
// `driftedTargets.length`, or the two cases are indistinguishable.
function unloadablePackDrift(slug: string): CurrentPackReport {
  return { slug, name: undefined, driftedTargets: [], previewInFlight: false };
}

function matchingPackDrift(slug: string): CurrentPackReport {
  return { slug, name: "Some Pack", driftedTargets: [], previewInFlight: false };
}

function driftedPackDrift(slug: string): CurrentPackReport {
  return { slug, name: "Some Pack", driftedTargets: ["oh-my-posh"], previewInFlight: false };
}

// CHM-55: the reporter's own bug was a drift warning that was really just
// the picker running in another pane. `driftedTargets` looks identical to a
// genuine CHM-27 partial-apply drift — only `previewInFlight` tells them
// apart — so formatDriftLine must never collapse the two into one wording.
function previewInFlightDrift(slug: string): CurrentPackReport {
  return { slug, name: "Some Pack", driftedTargets: ["oh-my-posh"], previewInFlight: true };
}

describe("formatDriftLine", () => {
  it("reports nothing to compare when no pack has ever been applied", () => {
    expect(formatDriftLine(undefined)).toBe("drift: no pack has been applied yet — nothing to compare");
  });

  // The deleted-pack case (CHM-34's reproduction): the state file still
  // names a slug, but it no longer resolves to a loadable pack, so no
  // comparison ever ran.
  it("says the check could not run when the recorded pack is no longer available, rather than claiming a match", () => {
    const line = formatDriftLine(unloadablePackDrift("no-such-deleted-pack"));

    expect(line).toBe('cannot check drift: pack "no-such-deleted-pack" is no longer available');
    expect(line).not.toMatch(/drift: none/);
  });

  it("reports none when every detected target matches the recorded, loadable pack", () => {
    expect(formatDriftLine(matchingPackDrift("catppuccin-dark"))).toBe('drift: none — every detected target matches "catppuccin-dark"');
  });

  it("names the targets that no longer match the recorded pack", () => {
    expect(formatDriftLine(driftedPackDrift("catppuccin-dark"))).toBe('drift: oh-my-posh no longer matches "catppuccin-dark"');
  });

  // CHM-55: same driftedTargets as the case above, but previewInFlight
  // changes the wording entirely — never "no longer matches", and never the
  // word "drift" standing alone, since this is not drift.
  it("reports a preview in flight instead of drift, naming the fix, when the marker is on record", () => {
    const line = formatDriftLine(previewInFlightDrift("catppuccin-dark"));

    expect(line).toContain("a theme preview is in progress");
    expect(line).toContain("oh-my-posh");
    expect(line).toContain("chm undo");
    expect(line).not.toMatch(/no longer matches/);
  });

  it("still reports a clean match, not a preview notice, when nothing has actually drifted even with the marker on record", () => {
    expect(formatDriftLine({ slug: "catppuccin-dark", name: "Some Pack", driftedTargets: [], previewInFlight: true })).toBe(
      'drift: none — every detected target matches "catppuccin-dark"',
    );
  });
});

// CHM-65: doctor is what someone runs when a theme looks wrong, and a stale
// Claude Code session is the single most common reason for that — the row
// must name the restart whenever Claude Code is installed, and never invent
// one for a target that is not there to restart.
describe("formatClaudeCodeRestartNote", () => {
  it("names the restart when Claude Code is installed", () => {
    expect(formatClaudeCodeRestartNote(true)).toBe(
      "  restart Claude Code to pick up a theme change — it reads its theme once, at startup",
    );
  });

  it("says nothing when Claude Code is not installed", () => {
    expect(formatClaudeCodeRestartNote(false)).toBeUndefined();
  });
});

// CHM-67: a successful apply used to print one line per target even though
// four of the five lines in the ticket's own example all said the same
// thing — it worked. `formatNoteworthyResultLines` is what runApply/runUndo
// now print after their own one-line "applied <slug>"/"restored" headline,
// so these prove the headline is genuinely the only line left in the plain
// case, and that a failure or a carried detail still surface.
describe("formatNoteworthyResultLines", () => {
  it("says nothing at all when every target simply applied, with no detail to add", () => {
    const results: readonly PackActionResult[] = [
      { target: "windows-terminal", status: "applied" },
      { target: "oh-my-posh", status: "applied" },
    ];

    expect(formatNoteworthyResultLines(results)).toEqual({ stdoutLines: [], stderrLines: [] });
  });

  // The routine case a person without Herdr would otherwise see on every
  // single apply — CHM-67's own headline complaint. `chm doctor` is where
  // this is worth reporting, not here.
  it("drops a plain not-installed skip rather than printing it every apply", () => {
    const results: readonly PackActionResult[] = [
      { target: "windows-terminal", status: "applied" },
      { target: "herdr", status: "skipped", detail: "not installed" },
    ];

    expect(formatNoteworthyResultLines(results)).toEqual({ stdoutLines: [], stderrLines: [] });
  });

  // Claude Code's own restart notice (CHM-49) — the one case this ticket
  // names explicitly as still worth a line even on outright success, since it
  // is the difference between "applied" and "applied but you will not see it
  // yet". Oh My Posh's profile-creation notice (CHM-39) and Herdr's "nothing
  // running to reload" (CHM-45) are the same shape: a detail on success is
  // new information, not noise.
  it("keeps a carried detail on an outright success, on stdout", () => {
    const results: readonly PackActionResult[] = [
      { target: "windows-terminal", status: "applied" },
      { target: "claude-code", status: "applied", detail: "restart Claude Code to see it" },
    ];

    expect(formatNoteworthyResultLines(results)).toEqual({
      stdoutLines: ["claude-code: applied — restart Claude Code to see it"],
      stderrLines: [],
    });
  });

  // CHM-27: a failed target is named with its reason, on stderr — but see the
  // next test for the other half of this rule.
  it("names a failed target and its reason, on stderr", () => {
    const results: readonly PackActionResult[] = [
      { target: "windows-terminal", status: "applied" },
      { target: "oh-my-posh", status: "failed", detail: "permission denied" },
    ];

    expect(formatNoteworthyResultLines(results)).toEqual({
      stdoutLines: [],
      stderrLines: ["oh-my-posh: failed — permission denied"],
    });
  });

  // "Do not print the targets that succeeded" — once one target needs
  // attention, a wall of "this one was fine" lines (even a carried detail
  // like Claude Code's restart notice) is exactly the noise this ticket
  // removes; CHM-27's own partial-apply warning is the thing to read next.
  it("prints only the failure when a failure and a successful detail both exist", () => {
    const results: readonly PackActionResult[] = [
      { target: "windows-terminal", status: "failed", detail: "permission denied" },
      { target: "claude-code", status: "applied", detail: "restart Claude Code to see it" },
    ];

    expect(formatNoteworthyResultLines(results)).toEqual({
      stdoutLines: [],
      stderrLines: ["windows-terminal: failed — permission denied"],
    });
  });

  it("names every failed target when more than one fails", () => {
    const results: readonly PackActionResult[] = [
      { target: "windows-terminal", status: "failed", detail: "permission denied" },
      { target: "oh-my-posh", status: "failed", detail: "config locked" },
    ];

    expect(formatNoteworthyResultLines(results)).toEqual({
      stdoutLines: [],
      stderrLines: ["windows-terminal: failed — permission denied", "oh-my-posh: failed — config locked"],
    });
  });

  // `chm undo`'s own "restored" status carries the same detail contract as
  // "applied" — nothing new here, just proof the two statuses are treated
  // alike rather than only "applied" getting the carried-detail exception.
  it("keeps a carried detail on a restored target the same way it does for applied", () => {
    const results: readonly PackActionResult[] = [{ target: "herdr", status: "restored", detail: "Herdr is not running — nothing to reload" }];

    expect(formatNoteworthyResultLines(results)).toEqual({
      stdoutLines: ["herdr: restored — Herdr is not running — nothing to reload"],
      stderrLines: [],
    });
  });
});

describe("hasDrift", () => {
  it("is false when no pack has ever been applied", () => {
    expect(hasDrift(undefined)).toBe(false);
  });

  // Exit code must reflect that the check could not run, rather than success
  // — the other half of CHM-34's fix.
  it("is true when the recorded pack could not be loaded, even though driftedTargets is empty", () => {
    expect(hasDrift(unloadablePackDrift("no-such-deleted-pack"))).toBe(true);
  });

  it("is false when every detected target matches the recorded pack", () => {
    expect(hasDrift(matchingPackDrift("catppuccin-dark"))).toBe(false);
  });

  it("is true when a target no longer matches the recorded pack", () => {
    expect(hasDrift(driftedPackDrift("catppuccin-dark"))).toBe(true);
  });
});

// Real bundled packs (loadCuratedThemePacks/mergeThemePacksBySlug), not
// invented fixtures — see CLAUDE.md's "colour tests use real schemes' real
// values." Catppuccin's own two packs (catppuccin-dark "Catppuccin Mocha",
// catppuccin-light "Catppuccin Latte") share a slug and name prefix, which is
// exactly what makes them useful here: real cases of an exact match, a
// prefix that must read as ambiguous, and a near-miss with an obvious "did
// you mean".
const BUNDLED_PACKS: readonly LoadedThemePack[] = mergeThemePacksBySlug(loadCuratedThemePacks(), []);

function findBundledPack(slug: string): LoadedThemePack {
  const loaded = BUNDLED_PACKS.find((candidate) => candidate.pack.manifest.slug === slug);
  if (!loaded) throw new Error(`test fixture error: no bundled pack named "${slug}"`);
  return loaded;
}

/**
 * `count` picker entries, cycling through the real bundled packs' own
 * ground/body colours (never invented hex) but with synthetic, fixed-width
 * names — "Synthetic Theme 001", "010", "100" — so a list this large has no
 * substring collisions between one entry's name and another's. Only
 * renderPickerFrame's *layout* is under test here (gutter width, name
 * column, row width, the footer's count): none of it depends on which real
 * pack a colour came from, and the 29 bundled packs are not enough entries
 * to reach the three-digit row numbers CHM-66's alignment rule names.
 */
function buildSyntheticEntries(count: number): PickerEntry[] {
  const templates = BUNDLED_PACKS.map(toPickerEntry);
  const digits = String(count).length;
  return Array.from({ length: count }, (_unused, index) => {
    const template = templates[index % templates.length]!;
    return { ...template, slug: `synthetic-${index + 1}`, name: `Synthetic Theme ${String(index + 1).padStart(digits, "0")}` };
  });
}

/** The rendered rows out of one renderPickerFrame call — the header and, when present, the footer stripped away. Assumes an empty filter, so there is no filter line to also strip. */
function pickerFrameRowLines(frame: readonly string[]): string[] {
  const withoutHeader = frame.slice(1);
  const lastLine = withoutHeader[withoutHeader.length - 1];
  const hasFooter = lastLine !== undefined && /^↓ \d+ more$/.test(lastLine);
  return hasFooter ? withoutHeader.slice(0, -1) : withoutHeader;
}

describe("normalizeThemeQuery", () => {
  it("lowercases and strips separators so a slug, a name and joined words all collapse to the same key", () => {
    expect(normalizeThemeQuery("Catppuccin Mocha")).toBe("catppuccinmocha");
    expect(normalizeThemeQuery("catppuccin-mocha")).toBe("catppuccinmocha");
    expect(normalizeThemeQuery("catppuccin_mocha")).toBe("catppuccinmocha");
    expect(normalizeThemeQuery("CATPPUCCIN MOCHA")).toBe("catppuccinmocha");
  });
});

describe("formatThemeLine", () => {
  it("shows the display name, never the slug", () => {
    const line = formatThemeLine(findBundledPack("catppuccin-dark"));
    expect(line).toContain("Catppuccin Mocha");
    expect(line).not.toContain("catppuccin-dark");
  });

  it("carries no marker at all for the bundled default — CHM-42's 'a tag on every row means nothing'", () => {
    const line = formatThemeLine(findBundledPack("catppuccin-dark"));
    expect(line).not.toContain("(bundled)");
    expect(line).not.toContain("(user)");
  });

  it("marks a user pack, and only a user pack", () => {
    const bundled = findBundledPack("catppuccin-dark");
    const userPack: LoadedThemePack = { ...bundled, origin: "user" };
    expect(formatThemeLine(userPack)).toContain("(user)");
  });
});

// CHM-64: the picker paints each row in that pack's own colours — its own
// ground behind its own body — rather than the name in default text beside
// two small swatches. CHM-66 then dropped the swatches entirely and added
// tint's own marker column and number gutter in front of that paint. Real
// bundled packs, by name, per CLAUDE.md's "colour tests use real schemes'
// real values."
describe("renderPickerRow", () => {
  // Solarized Dark and Catppuccin Latte are named fixtures elsewhere in this
  // project (CLAUDE.md's known-failure list, code-standards.md) precisely
  // because their own numbers are unusual — a good pair to prove the row's
  // background and foreground are that pack's own values, not a coincidence.
  const SAMPLE_SLUGS = ["catppuccin-dark", "solarized-dark", "solarized-light", "gruvbox-light"];

  /** Just enough layout for a single row on its own — a one-wide gutter and a content width equal to what that one row actually needs, so padding never enters into it. */
  function singleRowLayout(entry: PickerEntry): { gutterDigits: number; contentWidth: number } {
    const userMarker = entry.origin === "user" ? "  (user)" : "";
    return { gutterDigits: 1, contentWidth: `  1.  ${entry.name}${userMarker}`.length };
  }

  it.each(SAMPLE_SLUGS)("paints %s's row in its own ground and body, with no accent swatch", (slug) => {
    const loaded = findBundledPack(slug);
    const roleHexes = loaded.pack.payloads["oh-my-posh"];
    const entry = toPickerEntry(loaded);

    const row = renderPickerRow(entry, { displayNumber: 1, isHighlighted: false, isApplied: false }, singleRowLayout(entry));

    expect(row).toContain(sgrColorEscape(48, roleHexes.ground));
    expect(row).toContain(sgrColorEscape(38, roleHexes.body));
    expect(row).not.toContain(sgrColorEscape(48, roleHexes.accent));
    expect(row).toContain(loaded.pack.manifest.name);
  });

  it("marks a user pack, and only a user pack, the same way formatThemeLine does", () => {
    const bundled = findBundledPack("catppuccin-dark");
    const userEntry = toPickerEntry({ ...bundled, origin: "user" });
    const bundledEntry = toPickerEntry(bundled);
    const position = { displayNumber: 1, isHighlighted: false, isApplied: false };

    expect(renderPickerRow(userEntry, position, singleRowLayout(userEntry))).toContain("(user)");
    expect(renderPickerRow(bundledEntry, position, singleRowLayout(bundledEntry))).not.toContain("(user)");
  });

  // The acceptance criterion, directly: with every row now painted in its
  // own pack's colours, the highlighted row can no longer be marked with a
  // fixed background tint — some pack's own ground would match it and the
  // highlight would vanish. Reverse video (SGR 7) swaps whatever foreground
  // and background are already set, so it never depends on what those
  // values are. Proved on every bundled pack, including the lightest and
  // the darkest by measured ground luminance — not just a couple of named
  // samples — because "vanishes on some theme" is exactly the failure mode
  // a sample could miss.
  describe("the highlighted-row marker", () => {
    const allEntries = BUNDLED_PACKS.map(toPickerEntry);
    const byGroundLuminance = [...allEntries].sort(
      (entryA, entryB) => relativeLuminance(entryA.groundHex) - relativeLuminance(entryB.groundHex),
    );
    const darkestEntry = byGroundLuminance[0]!;
    const lightestEntry = byGroundLuminance[byGroundLuminance.length - 1]!;

    it("covers all 29 bundled packs, the darkest and lightest included", () => {
      expect(allEntries.length).toBe(29);
    });

    it("is present on the darkest pack's ground", () => {
      const row = renderPickerRow(darkestEntry, { displayNumber: 1, isHighlighted: true, isApplied: false }, singleRowLayout(darkestEntry));
      expect(row).toContain(SGR_REVERSE_VIDEO);
    });

    it("is present on the lightest pack's ground", () => {
      const row = renderPickerRow(lightestEntry, { displayNumber: 1, isHighlighted: true, isApplied: false }, singleRowLayout(lightestEntry));
      expect(row).toContain(SGR_REVERSE_VIDEO);
    });

    it.each(allEntries)("marks $name highlighted, and only when highlighted", (entry) => {
      const layout = singleRowLayout(entry);
      expect(renderPickerRow(entry, { displayNumber: 1, isHighlighted: true, isApplied: false }, layout)).toContain(SGR_REVERSE_VIDEO);
      expect(renderPickerRow(entry, { displayNumber: 1, isHighlighted: false, isApplied: false }, layout)).not.toContain(
        SGR_REVERSE_VIDEO,
      );
    });
  });

  // CHM-66: the highlighted and applied markers sit outside a row's own SGR
  // paint entirely (see renderPickerRow), specifically so they read on any
  // pack's own colours rather than depending on them — proved on the same
  // darkest/lightest pair the reverse-video highlight is proved against
  // above, by name.
  describe("the highlighted and applied markers", () => {
    const allEntries = BUNDLED_PACKS.map(toPickerEntry);
    const byGroundLuminance = [...allEntries].sort(
      (entryA, entryB) => relativeLuminance(entryA.groundHex) - relativeLuminance(entryB.groundHex),
    );
    const darkestEntry = byGroundLuminance[0]!;
    const lightestEntry = byGroundLuminance[byGroundLuminance.length - 1]!;
    const NAMED_PACKS = [
      ["darkest", darkestEntry] as const,
      ["lightest", lightestEntry] as const,
    ];

    it.each(NAMED_PACKS)("shows '>' for the highlighted row on the %s bundled pack", (_label, entry) => {
      const row = renderPickerRow(entry, { displayNumber: 1, isHighlighted: true, isApplied: false }, singleRowLayout(entry));
      expect(stripAnsiEscapes(row).startsWith(">")).toBe(true);
    });

    it.each(NAMED_PACKS)("shows '*' for the applied row on the %s bundled pack, when it is not also highlighted", (_label, entry) => {
      const row = renderPickerRow(entry, { displayNumber: 1, isHighlighted: false, isApplied: true }, singleRowLayout(entry));
      expect(stripAnsiEscapes(row).startsWith("*")).toBe(true);
    });

    it("leaves the marker blank for a row that is neither highlighted nor applied", () => {
      const row = renderPickerRow(lightestEntry, { displayNumber: 1, isHighlighted: false, isApplied: false }, singleRowLayout(lightestEntry));
      expect(stripAnsiEscapes(row).startsWith(" ")).toBe(true);
    });

    it("prefers the highlighted marker when the cursor sits on the applied row", () => {
      const row = renderPickerRow(lightestEntry, { displayNumber: 1, isHighlighted: true, isApplied: true }, singleRowLayout(lightestEntry));
      expect(stripAnsiEscapes(row).startsWith(">")).toBe(true);
    });
  });
});

// CHM-52 set the bar this ticket must not cross back over: per-row work is
// string concatenation over values every pack already carries, so it should
// be free — this asserts that rather than assuming it. CHM-66 adds a gutter
// and a fixed-width pad on top, so the same budget is re-asserted here
// rather than assumed to still hold.
describe("the picker's per-row render cost", () => {
  it("renders every bundled pack's row, highlighted and not, in well under 30ms total", () => {
    const entries = BUNDLED_PACKS.map(toPickerEntry);
    const layout = { gutterDigits: 2, contentWidth: 60 };

    const startedAtMs = performance.now();
    for (const [index, entry] of entries.entries()) {
      renderPickerRow(entry, { displayNumber: index + 1, isHighlighted: false, isApplied: false }, layout);
      renderPickerRow(entry, { displayNumber: index + 1, isHighlighted: true, isApplied: false }, layout);
    }
    const elapsedMs = performance.now() - startedAtMs;

    expect(elapsedMs).toBeLessThan(30);
  });
});

// CHM-66: the rest of the restyle — no swatch, the header, the numbered
// gutter, equal-width rows and the footer — lives in how renderPickerFrame
// assembles a whole frame's worth of rows, not in any one row on its own.
describe("renderPickerFrame", () => {
  it("always shows tint's three-part navigation header, plain text but for the two arrows", () => {
    const entries = [toPickerEntry(findBundledPack("catppuccin-dark"))];

    const frame = renderPickerFrame(entries, 0, "", undefined);

    expect(frame[0]).toBe("↑/↓ Navigate    Enter: Select    Esc: Cancel");
  });

  it("shows the filter line only once something has actually been typed", () => {
    const entries = [toPickerEntry(findBundledPack("catppuccin-dark"))];

    expect(renderPickerFrame(entries, 0, "", undefined).some((line) => line.startsWith("filter:"))).toBe(false);
    expect(renderPickerFrame(entries, 0, "moc", undefined).some((line) => line.startsWith("filter: moc"))).toBe(true);
  });

  // The acceptance criterion, directly: "1. and 10. and 100. all end at the
  // same column" — proved against a list long enough to actually reach
  // three digits, not just the 29 bundled packs. The gutter is sized from
  // the whole filtered list, so the name column stays put across every
  // frame this list ever renders, no matter which rows have scrolled into
  // view — that is what lets each of these three frames be compared here.
  it("lines up the name column for single-, double- and triple-digit row numbers", () => {
    const entries = buildSyntheticEntries(150);
    const nameColumnFor = (highlightedIndex: number): number => {
      const frame = renderPickerFrame(entries, highlightedIndex, "", undefined);
      const targetName = entries[highlightedIndex]!.name;
      const line = frame.find((frameLine) => frameLine.includes(targetName));
      if (line === undefined) throw new Error(`test fixture error: row for "${targetName}" was not in the rendered window`);
      return stripAnsiEscapes(line).indexOf(targetName);
    };

    const singleDigitColumn = nameColumnFor(0); // row "1."
    const doubleDigitColumn = nameColumnFor(9); // row "10."
    const tripleDigitColumn = nameColumnFor(99); // row "100."

    expect(doubleDigitColumn).toBe(singleDigitColumn);
    expect(tripleDigitColumn).toBe(singleDigitColumn);
  });

  it("pads every rendered row to the same display width, measured excluding escape sequences", () => {
    const entries = buildSyntheticEntries(40);

    const frame = renderPickerFrame(entries, 0, "", undefined);
    const rowWidths = pickerFrameRowLines(frame).map((line) => stripAnsiEscapes(line).length);

    expect(new Set(rowWidths).size).toBe(1);
  });

  describe("the footer", () => {
    it("does not appear when every entry already fits in the visible window", () => {
      const entries = buildSyntheticEntries(5);

      const frame = renderPickerFrame(entries, 0, "", undefined);

      expect(frame.some((line) => line.includes("more"))).toBe(false);
    });

    it("names exactly how many entries sit below the visible window", () => {
      const entries = buildSyntheticEntries(40);

      const frame = renderPickerFrame(entries, 0, "", undefined);
      const shownCount = pickerFrameRowLines(frame).length;

      expect(frame[frame.length - 1]).toBe(`↓ ${entries.length - shownCount} more`);
    });

    // The acceptance criterion, directly: "the footer's count is correct
    // when the list is filtered" — a shorter, filtered list must recompute
    // against its own, smaller total rather than the count from before the
    // filter narrowed it.
    it("recomputes against a filtered list's own, smaller total", () => {
      const filtered = buildSyntheticEntries(40).slice(0, 20);

      const frame = renderPickerFrame(filtered, 0, "", undefined);
      const shownCount = pickerFrameRowLines(frame).length;

      expect(frame[frame.length - 1]).toBe(`↓ ${filtered.length - shownCount} more`);
    });
  });
});
describe("resolveThemeQuery", () => {
  it("resolves an exact slug", () => {
    const result = resolveThemeQuery(BUNDLED_PACKS, ["catppuccin-dark"]);
    expect(result).toEqual({ status: "resolved", loaded: findBundledPack("catppuccin-dark") });
  });

  it("resolves a quoted display name, case- and separator-insensitively", () => {
    const result = resolveThemeQuery(BUNDLED_PACKS, ["CATPPUCCIN-MOCHA"]);
    expect(result).toEqual({ status: "resolved", loaded: findBundledPack("catppuccin-dark") });
  });

  it("resolves several bare words joined into one name", () => {
    const result = resolveThemeQuery(BUNDLED_PACKS, ["catppuccin", "mocha"]);
    expect(result).toEqual({ status: "resolved", loaded: findBundledPack("catppuccin-dark") });
  });

  it("lists every candidate for an ambiguous prefix rather than guessing one", () => {
    const result = resolveThemeQuery(BUNDLED_PACKS, ["catppuccin"]);
    expect(result.status).toBe("ambiguous");
    if (result.status !== "ambiguous") throw new Error("unreachable");
    const candidateSlugs = result.candidates.map((loaded) => loaded.pack.manifest.slug).sort();
    expect(candidateSlugs).toEqual(["catppuccin-dark", "catppuccin-light"]);
  });

  it("suggests the closest match for a name that resolves to nothing", () => {
    const result = resolveThemeQuery(BUNDLED_PACKS, ["Catpuccin Mocha"]);
    expect(result.status).toBe("unknown");
    if (result.status !== "unknown") throw new Error("unreachable");
    expect(result.closest?.pack.manifest.slug).toBe("catppuccin-dark");
  });
});

// CHM-56: two `chm` processes have no idea the other exists, so a picker
// open for its whole browsing session and a one-shot write both take the
// same lock before writing anything — a second one that cannot take it must
// say so, naming exactly who holds it, rather than silently racing it.
describe("formatLockHeldMessage", () => {
  it("names the command and the pid holding the lock", () => {
    const message = formatLockHeldMessage({ pid: 4242, command: "chm themes", acquiredAtMs: Date.now() });
    expect(message).toContain("chm themes");
    expect(message).toContain("4242");
  });

  it("still says a process is writing when the holder itself could not be read", () => {
    const message = formatLockHeldMessage(undefined);
    expect(message).toMatch(/writing/);
  });
});

// CHM-56: a target's live config can legitimately disagree with the recorded
// pack for as long as a debounced preview write is still in flight — `chm
// current` must say that plainly rather than reporting it as drift.
describe("formatPreviewInProgressLine", () => {
  it("names the command holding the lock, not the recorded pack's drift", () => {
    const line = formatPreviewInProgressLine({ pid: 4242, command: "chm themes", acquiredAtMs: Date.now() });
    expect(line).toContain("chm themes");
    expect(line).not.toMatch(/drift: none|no longer matches/);
  });
});

// CHM-56's own core fix: the picker's Esc/Ctrl-C must not silently revert a
// real apply made by another process while it was open — see
// index.pack-commands.test.ts's "dracula survives" for the full sequence
// through the real library orchestration; these exercise the decision
// itself, in isolation, for every combination of "was something active
// before/is something active now."
describe("shouldRestoreOriginalSelectionOnExit", () => {
  it("restores when the active selection is still exactly what it was when the picker opened", () => {
    expect(shouldRestoreOriginalSelectionOnExit("solarized-dark", "solarized-dark")).toBe(true);
  });

  it("does not restore when a real apply changed the active selection while the picker was open", () => {
    expect(shouldRestoreOriginalSelectionOnExit("solarized-dark", "dracula-dark")).toBe(false);
  });

  it("restores (to nothing active) when nothing was active before and nothing is active now", () => {
    expect(shouldRestoreOriginalSelectionOnExit(undefined, undefined)).toBe(true);
  });

  it("does not restore when nothing was active before, but a real apply made something active since", () => {
    expect(shouldRestoreOriginalSelectionOnExit(undefined, "dracula-dark")).toBe(false);
  });
});

describe("USAGE", () => {
  it("names `chm themes` as the way to browse", () => {
    expect(USAGE).toContain("chm themes");
  });

  // CHM-44: chm themes moved from listing to picking, and the usage text has
  // to say so plainly rather than still reading like a static list command.
  it("describes `chm themes` as browsing/picking, not listing", () => {
    expect(USAGE).toMatch(/chm themes\s+browse and pick/);
    expect(USAGE).toContain("chm themes --list");
    expect(USAGE).toContain("chm pick");
  });
});

// CHM-44: `chm themes` opens the picker, but only when both streams are a
// real TTY — reading arrow keys needs a real stdin, and repainting frames
// needs a real stdout, so a pipe on either end (or an explicit `--list`)
// must fall back to the plain, scriptable list instead.
describe("wantsPlainThemeList", () => {
  it("is false in a real terminal with no --list flag — the picker opens", () => {
    expect(wantsPlainThemeList([], true, true)).toBe(false);
  });

  it("is true when --list is given, even in a real terminal", () => {
    expect(wantsPlainThemeList(["--list"], true, true)).toBe(true);
  });

  it("is true when stdout is piped, so escape codes never land in the pipe", () => {
    expect(wantsPlainThemeList([], true, false)).toBe(true);
  });

  it("is true when stdin isn't a TTY, so it never blocks on arrow keys that can't arrive", () => {
    expect(wantsPlainThemeList([], false, true)).toBe(true);
  });
});

// CHM-52: previewHighlighted() used to call applyThemePack — a full
// four-target apply, ~324ms measured in-process — on every arrow key. The
// picker's own preview is now these escape codes, pushed straight to the
// terminal; a real bundled pack's own scheme (catppuccin-dark), never
// invented hex, so a wrong palette index or a swapped OSC code would show up
// against real values.
describe("buildTerminalPreviewSequence", () => {
  const scheme = findBundledPack("catppuccin-dark").pack.payloads["windows-terminal"];

  it("sets every ANSI slot by OSC 4, at the slot's own numbered index", () => {
    const sequence = buildTerminalPreviewSequence(scheme);

    expect(sequence).toContain(`\x1b]4;0;${scheme.black}\x07`);
    expect(sequence).toContain(`\x1b]4;1;${scheme.red}\x07`);
    expect(sequence).toContain(`\x1b]4;7;${scheme.white}\x07`);
    expect(sequence).toContain(`\x1b]4;8;${scheme.brightBlack}\x07`);
    expect(sequence).toContain(`\x1b]4;15;${scheme.brightWhite}\x07`);
  });

  it("sets the terminal's own foreground, background and cursor by OSC 10/11/12", () => {
    const sequence = buildTerminalPreviewSequence(scheme);

    expect(sequence).toContain(`\x1b]10;${scheme.foreground}\x07`);
    expect(sequence).toContain(`\x1b]11;${scheme.background}\x07`);
    expect(sequence).toContain(`\x1b]12;${scheme.cursorColor}\x07`);
  });

  it("never touches a config file — it is a plain string, nothing more", () => {
    expect(typeof buildTerminalPreviewSequence(scheme)).toBe("string");
  });
});

describe("buildTerminalResetSequence", () => {
  it("resets every ANSI slot by OSC 104 and the terminal's own fg/bg/cursor by OSC 110/111/112 — the reverse of buildTerminalPreviewSequence, for Esc when nothing was active before the picker opened", () => {
    const sequence = buildTerminalResetSequence();

    for (let paletteIndex = 0; paletteIndex < 16; paletteIndex += 1) {
      expect(sequence).toContain(`\x1b]104;${paletteIndex}\x07`);
    }
    expect(sequence).toContain("\x1b]110\x07");
    expect(sequence).toContain("\x1b]111\x07");
    expect(sequence).toContain("\x1b]112\x07");
  });

  it("carries no colour of its own — a reset, not a preview of anything", () => {
    expect(buildTerminalResetSequence()).not.toMatch(/#[0-9a-f]{6}/i);
  });
});

// CHM-52: Herdr, Oh My Posh and Claude Code can only be previewed with a
// real file write, so createSettledFileTargetPreview is what turns "one
// apply per keystroke" into "one apply once movement settles" — the fix for
// "holding the key for 10 rows: 3.2s of frozen UI" and for burying undo
// history under 100 previews of themes the user never chose.
describe("createSettledFileTargetPreview", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not apply at all until the debounce delay has passed", () => {
    const applyToFileTargets = vi.fn();
    const scheduler = createSettledFileTargetPreview(applyToFileTargets, 150);

    scheduler.schedule("catppuccin-dark");
    vi.advanceTimersByTime(149);

    expect(applyToFileTargets).not.toHaveBeenCalled();
  });

  it("applies once the debounce delay has passed", () => {
    const applyToFileTargets = vi.fn();
    const scheduler = createSettledFileTargetPreview(applyToFileTargets, 150);

    scheduler.schedule("catppuccin-dark");
    vi.advanceTimersByTime(150);

    expect(applyToFileTargets).toHaveBeenCalledTimes(1);
    expect(applyToFileTargets).toHaveBeenCalledWith("catppuccin-dark");
  });

  // The acceptance criterion, directly: holding an arrow key through every
  // one of the 29 bundled packs, with no pause between rows, must perform a
  // small, bounded number of file applies — not one per row. Scheduling 29
  // times in a row with no time advance between them, then settling once,
  // proves it is bounded to exactly one, superseding every row passed
  // through rather than queuing behind them.
  it("holding an arrow key through 29 rows with no pause performs exactly one file apply, for the last row reached", () => {
    const applyToFileTargets = vi.fn();
    const scheduler = createSettledFileTargetPreview(applyToFileTargets, 150);
    const slugs = BUNDLED_PACKS.map((loaded) => loaded.pack.manifest.slug);
    expect(slugs.length).toBeGreaterThan(1);

    for (const slug of slugs) {
      scheduler.schedule(slug);
    }
    vi.advanceTimersByTime(150);

    expect(applyToFileTargets).toHaveBeenCalledTimes(1);
    expect(applyToFileTargets).toHaveBeenCalledWith(slugs[slugs.length - 1]);
  });

  it("cancel prevents a pending apply from ever firing — what Enter and Esc both call before taking over the final write themselves", () => {
    const applyToFileTargets = vi.fn();
    const scheduler = createSettledFileTargetPreview(applyToFileTargets, 150);

    scheduler.schedule("catppuccin-dark");
    scheduler.cancel();
    vi.advanceTimersByTime(150);

    expect(applyToFileTargets).not.toHaveBeenCalled();
  });
});

// CHM-52's own headline number: moving the highlight one row must cost under
// 30ms of blocking work, not the 324ms a full four-target apply measured.
// What actually runs synchronously on a keystroke, now that the file-writing
// targets are debounced, is building the terminal's own escape sequence and
// scheduling (never running) the settled file-target preview — this times
// that exact pair, back to back, for every bundled pack, the same "hold the
// arrow key through the whole list" scenario the ticket asks to verify.
describe("the picker's per-keystroke preview cost", () => {
  it("builds a preview sequence and schedules the settled file-target apply for every bundled pack in well under 30ms total", () => {
    const scheduler = createSettledFileTargetPreview(() => undefined, 150);

    const startedAtMs = performance.now();
    for (const loaded of BUNDLED_PACKS) {
      buildTerminalPreviewSequence(loaded.pack.payloads["windows-terminal"]);
      scheduler.schedule(loaded.pack.manifest.slug);
    }
    const elapsedMs = performance.now() - startedAtMs;

    expect(elapsedMs).toBeLessThan(30);
  });
});
