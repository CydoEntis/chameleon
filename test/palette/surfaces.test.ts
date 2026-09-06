import { describe, expect, it } from "vitest";
import { ACTIVE_ROW_MIN_VISIBLE_RATIO, ANSI_MIN_RATIO, MUTED_MIN_RATIO, RATIO_CLEARANCE_MARGIN, SELECTION_MIN_VISIBLE_RATIO, TEXT_MIN_RATIO } from "../../src/constants.js";
import { repairCursorColor } from "../../src/palette/ansi.js";
import { contrastRatio, mix } from "../../src/palette/color.js";
import { resolveRoleHexes } from "../../src/palette/repair.js";
import { resolveSelectionAndBody } from "../../src/palette/selection.js";
import { loadCuratedThemePacks } from "../../src/palette/theme-pack-library.js";
import {
  ACTIVE_ROW_IDEAL_FRACTION,
  checkContrastPairs,
  herdrContrastPairs,
  OVERLAY_0_FRACTION,
  repairOverlay0,
  resolveActiveRowAndText,
  resolveActiveRowBackground,
  resolveHerdrBadgeTokens,
  windowsTerminalContrastPairs,
  type HerdrTokenSet,
} from "../../src/palette/surfaces.js";
import { listVendoredSchemeFileNames, readVendoredScheme } from "../../tools/vendor-scheme-library.js";

// Real vendored/bundled values (mbadolato/iTerm2-Color-Schemes, via
// vendor/iterm2-color-schemes) — never invented hex. See code-standards.md,
// "Colour tests use real schemes' real values".

// 12-bit Rainbow: an extreme-contrast scheme (near-black ground, near-white
// body) whose ideal-fraction row already clears both of
// resolveActiveRowBackground's floors — row-vs-ground (2.87) and
// muted-vs-row (4.77) alike — the one case where nothing here needs to move
// at all. No bundled pack actually reaches this fast path (CHM-75: muted's
// own resolved position always sits close enough to the row's own ideal
// lift to need at least one of the two repairs below), so this is drawn
// from the wider 606-scheme vendored library instead.
const NO_REPAIR = { ground: "#040404", body: "#feffff", muted: "#d3d3d3", selection: "#007ca6" };

// Ayu Light: the ideal fraction's own row-vs-sidebar clears
// ACTIVE_ROW_MIN_VISIBLE_RATIO (1.63) but muted cannot be read against it
// (3.25, short of TEXT_MIN_RATIO), so the row retreats toward ground — and,
// on this fixture, even the smallest fraction that stays visible still
// leaves muted short, so the second lever (repairMutedForActiveRow) fires
// on top of it. See resolveActiveRowAndText's own describe block below.
const AYU_LIGHT = { ground: "#f8f9fa", body: "#5a5f64", muted: "#686868", selection: "#d7dde4" };

// monokai-dark's own resolved role hexes (ground, body and muted post
// repairFailingRoles/resolveSelectionAndBody, muted post its own ordinary
// repair against ground and selection) — CHM-80's own worked case (this
// ticket's own reported bug): the ideal fraction's row already clears
// row-vs-ground (2.96) but muted-vs-row measures only 3.33, short of
// TEXT_MIN_RATIO. Before CHM-80, the row fell back only as far as muted's
// own readability demanded, landing at #585a52 (2.12 vs ground) and leaving
// muted at 4.63 on top of it — legal, barely. CHM-80 takes the smallest
// fraction that clears visibility at all regardless of muted, landing at
// #3a3b34 (1.31 vs ground) — muted's own value never needs a second repair,
// and reads at 7.49 against it instead of scraping 4.63.
const MONOKAI_DARK = { ground: "#272822", body: "#fdfff1", muted: "#d2d2d2", selection: "#007d95" };

// Dracula's own selected-row fixture, but fed a muted value too faint on
// its own (Dracula's real subtext0 measures 3.03 against ground, CHM-50's
// own four-fixture set) to fix by moving the row alone: even at the
// smallest fraction that still clears row-vs-ground, muted-vs-row only
// reaches 2.29. This is the case that needs both levers this ticket keeps —
// the row falls back for visibility, and muted repairs a second time on top
// of it, now comfortably past TEXT_MIN_RATIO (4.87) rather than capped short
// of it — CHM-80's own lower row floor leaves the second lever far more
// room than CHM-75's did.
const DRACULA = { ground: "#282a36", body: "#f8f8f2", muted: "#6272a4", selection: "#565864" };

// Darkermatrix: real vendored scheme bytes (vendor/iterm2-color-schemes),
// used raw rather than through the resolution pipeline. CHM-80 lowers
// ACTIVE_ROW_MIN_VISIBLE_RATIO far enough that no scheme in the entire
// 606-scheme vendored library still fails visibility at its own resolved
// ideal fraction (see this describe block's own "never needs to push
// further" proof below) — so there is no real *resolved* fixture left to
// demonstrate resolveActiveRowBackground's "push further from ground"
// branch. Darkermatrix's own raw background/foreground are real bytes from
// a real shipped theme that do still fail it (1.16), which is what this
// branch needs to exercise, even though no curated pack's own resolved
// values would ever reach here.
const DARKERMATRIX = { ground: "#070c0e", body: "#35451a", muted: "#404040", selection: "#0f191c" };

describe("resolveActiveRowBackground", () => {
  it("keeps the ideal ground/body blend unchanged when it already clears both the visibility and readability floors", () => {
    const activeRow = resolveActiveRowBackground(NO_REPAIR.ground, NO_REPAIR.body, NO_REPAIR.muted, ACTIVE_ROW_IDEAL_FRACTION);

    expect(activeRow.wasRepaired).toBe(false);
    expect(activeRow.hex).toBe(mix(NO_REPAIR.ground, NO_REPAIR.body, ACTIVE_ROW_IDEAL_FRACTION));
    expect(contrastRatio(activeRow.hex, NO_REPAIR.ground)).toBeGreaterThanOrEqual(ACTIVE_ROW_MIN_VISIBLE_RATIO);
    expect(contrastRatio(NO_REPAIR.muted, activeRow.hex)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
  });

  // No curated pack, and no scheme at all in the 606-scheme vendored
  // library, still reaches this branch under CHM-80's retuned floor (see
  // this describe block's own proof below) — Darkermatrix's raw, unrepaired
  // scheme bytes are used here instead, real values from a real shipped
  // theme rather than invented ones, chosen because they are extreme enough
  // to still fail even the lowered floor.
  it("pushes the row further toward body when the ideal blend falls short of the visibility floor", () => {
    const idealHex = mix(DARKERMATRIX.ground, DARKERMATRIX.body, ACTIVE_ROW_IDEAL_FRACTION);
    expect(contrastRatio(idealHex, DARKERMATRIX.ground)).toBeLessThan(ACTIVE_ROW_MIN_VISIBLE_RATIO);

    const activeRow = resolveActiveRowBackground(DARKERMATRIX.ground, DARKERMATRIX.body, DARKERMATRIX.muted, ACTIVE_ROW_IDEAL_FRACTION);

    expect(activeRow.wasRepaired).toBe(true);
    expect(contrastRatio(activeRow.hex, DARKERMATRIX.ground)).toBeGreaterThanOrEqual(ACTIVE_ROW_MIN_VISIBLE_RATIO);
    // Still a plain blend of this theme's own ground and body — every
    // channel sits between the two source colours' own matching channels —
    // never a colour invented from nowhere (CHM-38's own guarantee, held
    // here for the surface this ticket introduces).
    for (const channelOffset of [1, 3, 5]) {
      const groundChannel = Number.parseInt(DARKERMATRIX.ground.slice(channelOffset, channelOffset + 2), 16);
      const bodyChannel = Number.parseInt(DARKERMATRIX.body.slice(channelOffset, channelOffset + 2), 16);
      const rowChannel = Number.parseInt(activeRow.hex.slice(channelOffset, channelOffset + 2), 16);
      expect(rowChannel).toBeGreaterThanOrEqual(Math.min(groundChannel, bodyChannel));
      expect(rowChannel).toBeLessThanOrEqual(Math.max(groundChannel, bodyChannel));
    }
  });

  // No real scheme's own *resolved* ground/body pair ever fails visibility
  // at the ideal fraction any more (CHM-80's own retuned floor) — proof for
  // the claim the fixture comment above and resolveActiveRowBackground's own
  // doc comment both make, the same "positive evidence, not an assumed
  // impossibility" shape this file already uses for the retreat branch below.
  it("never needs to push further than the ideal blend for any of the 606 vendored library's own resolved ground/body pairs", () => {
    for (const fileName of listVendoredSchemeFileNames()) {
      const scheme = readVendoredScheme(fileName);
      const roleHexes = resolveRoleHexes(scheme);
      const { body } = resolveSelectionAndBody(
        scheme.selectionBackground,
        roleHexes.ground,
        roleHexes.body,
        roleHexes.accent,
        [roleHexes.success, roleHexes.error],
      );
      const idealHex = mix(roleHexes.ground, body.hex, ACTIVE_ROW_IDEAL_FRACTION);
      expect(contrastRatio(idealHex, roleHexes.ground), fileName).toBeGreaterThanOrEqual(ACTIVE_ROW_MIN_VISIBLE_RATIO);
    }
  });

  // CHM-80: the fix this ticket exists for. monokai-dark's subtext0 read at
  // 4.63 against the ideal-fraction row (legal against TEXT_MIN_RATIO, but
  // scraping it) even though the row itself had visibility to spare (2.96
  // against what was then a 2.0 floor). The old fix held the row as close to
  // that spare visibility as muted's own readability allowed; this one
  // takes the smallest lift off ground that clears visibility at all,
  // regardless of muted — which turns out to leave muted far better off, not
  // worse (7.49 here), because a smaller fraction can only ever help it.
  it("pulls the row back to the smallest fraction that clears visibility when the ideal blend clears visibility but muted cannot be read against it", () => {
    const idealHex = mix(MONOKAI_DARK.ground, MONOKAI_DARK.body, ACTIVE_ROW_IDEAL_FRACTION);
    expect(contrastRatio(idealHex, MONOKAI_DARK.ground)).toBeGreaterThanOrEqual(ACTIVE_ROW_MIN_VISIBLE_RATIO);
    expect(contrastRatio(MONOKAI_DARK.muted, idealHex)).toBeLessThan(TEXT_MIN_RATIO);

    const activeRow = resolveActiveRowBackground(MONOKAI_DARK.ground, MONOKAI_DARK.body, MONOKAI_DARK.muted, ACTIVE_ROW_IDEAL_FRACTION);

    expect(activeRow.wasRepaired).toBe(true);
    // The row moved — not muted: this is still MONOKAI_DARK.muted itself,
    // unrepaired, reading with a wide margin against the fraction the row
    // fell back to — not by scraping TEXT_MIN_RATIO the way the shipped
    // 4.63 did.
    expect(contrastRatio(activeRow.hex, MONOKAI_DARK.ground)).toBeGreaterThanOrEqual(ACTIVE_ROW_MIN_VISIBLE_RATIO);
    expect(contrastRatio(MONOKAI_DARK.muted, activeRow.hex)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO * RATIO_CLEARANCE_MARGIN);
    // The fallback is a real retreat toward ground, not the ideal blend
    // reproduced by coincidence.
    expect(activeRow.hex).not.toBe(idealHex);
    expect(activeRow.hex).toBe("#3a3b34");
  });
});

// CHM-78: adapters/herdr.ts's surfaceScale mixes overlay0 at 4/6 of the way
// from ground to body — duplicated here rather than imported, the same way
// this file's own ground/body/muted fixtures already stand in for herdr.ts's
// real inputs.
const OVERLAY_0_FRACTION = 4 / 6;

describe("repairOverlay0", () => {
  // The exact pair CHM-78's own ticket body measured on the reporter's live
  // config: overlay0 #b6b7ac on active_row_bg #585a52 read 3.45, short of
  // TEXT_MIN_RATIO even though overlay0 painted text there all along.
  // #585a52 was monokai-dark's own active_row_bg as CHM-78 shipped it — kept
  // here as a fixed historical value rather than re-derived from
  // resolveActiveRowBackground, since CHM-80 changed that function's own
  // output for this fixture to #3a3b34, which no longer reproduces the
  // failure (the candidate below already clears TEXT_MIN_RATIO against it).
  // repairOverlay0 itself is unchanged by CHM-80; this proves it still
  // repairs a genuinely failing pair when handed one.
  it("repairs the plain ramp value when it fails TEXT_MIN_RATIO against the active row — CHM-78's own reported case", () => {
    const preCHM80ActiveRowHex = "#585a52";
    const candidateHex = mix(MONOKAI_DARK.ground, MONOKAI_DARK.body, OVERLAY_0_FRACTION);
    expect(candidateHex).toBe("#b6b7ac");
    expect(contrastRatio(candidateHex, preCHM80ActiveRowHex)).toBeLessThan(TEXT_MIN_RATIO);

    const repaired = repairOverlay0(candidateHex, MONOKAI_DARK.ground, preCHM80ActiveRowHex);

    expect(repaired).not.toBe(candidateHex);
    expect(contrastRatio(repaired, MONOKAI_DARK.ground)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
    expect(contrastRatio(repaired, preCHM80ActiveRowHex)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
  });

  it("leaves an already-readable candidate unchanged", () => {
    // body itself always clears TEXT_MIN_RATIO against ground (see
    // repairFailingRoles) and, here, against the settled row too — a stand-in
    // for a candidate that needs no repair at all.
    const activeRow = resolveActiveRowBackground(MONOKAI_DARK.ground, MONOKAI_DARK.body, MONOKAI_DARK.muted, ACTIVE_ROW_IDEAL_FRACTION);
    expect(contrastRatio(MONOKAI_DARK.body, MONOKAI_DARK.ground)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
    expect(contrastRatio(MONOKAI_DARK.body, activeRow.hex)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);

    expect(repairOverlay0(MONOKAI_DARK.body, MONOKAI_DARK.ground, activeRow.hex)).toBe(MONOKAI_DARK.body);
  });
});

describe("resolveActiveRowAndText", () => {
  it("clears row-vs-sidebar, text-on-row and subtext0-on-row together, without needing either repair lever", () => {
    const resolved = resolveActiveRowAndText(NO_REPAIR.ground, NO_REPAIR.body, NO_REPAIR.muted, [NO_REPAIR.selection], ACTIVE_ROW_IDEAL_FRACTION);

    expect(resolved.wasVisibilityTraded).toBe(false);
    expect(resolved.subtextHex).toBe(NO_REPAIR.muted);
    expect(contrastRatio(resolved.activeRowBackgroundHex, NO_REPAIR.ground)).toBeGreaterThanOrEqual(ACTIVE_ROW_MIN_VISIBLE_RATIO);
    expect(contrastRatio(resolved.textHex, resolved.activeRowBackgroundHex)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
    expect(contrastRatio(resolved.subtextHex, resolved.activeRowBackgroundHex)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
    // Both floors hold against every surface passed in, not just the row —
    // the whole point of repairing them together rather than one at a time.
    expect(contrastRatio(resolved.textHex, NO_REPAIR.ground)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
    expect(contrastRatio(resolved.textHex, NO_REPAIR.selection)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
    expect(contrastRatio(resolved.subtextHex, NO_REPAIR.ground)).toBeGreaterThanOrEqual(MUTED_MIN_RATIO);
    expect(contrastRatio(resolved.subtextHex, NO_REPAIR.selection)).toBeGreaterThanOrEqual(MUTED_MIN_RATIO);
  });

  // CHM-80: under the retuned floor, Ayu Light's own retreat still is not
  // enough on its own — even the smallest fraction that clears visibility
  // (see this fixture's own comment above) leaves muted short of
  // TEXT_MIN_RATIO, so the second lever (repairMutedForActiveRow) fires on
  // top of it. Body itself clears ground by only 6.12, leaving little room
  // below it for muted to also clear TEXT_MIN_RATIO and stay measurably
  // below body at once — the cap catches muted just short here, the same
  // "maximise, never demand" shape SELECTION_IDEAL_RATIO already uses for
  // the selection highlight.
  it("retreats the row to the smallest visible fraction, then still needs a second repair for muted, for a pack the retreat alone cannot satisfy", () => {
    const resolved = resolveActiveRowAndText(AYU_LIGHT.ground, AYU_LIGHT.body, AYU_LIGHT.muted, [AYU_LIGHT.selection], ACTIVE_ROW_IDEAL_FRACTION);

    expect(resolved.wasVisibilityTraded).toBe(false);
    expect(resolved.subtextHex).not.toBe(AYU_LIGHT.muted);
    expect(contrastRatio(resolved.activeRowBackgroundHex, AYU_LIGHT.ground)).toBeGreaterThanOrEqual(ACTIVE_ROW_MIN_VISIBLE_RATIO);
    expect(contrastRatio(resolved.textHex, resolved.activeRowBackgroundHex)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
    // subtext0-on-row is maximised toward TEXT_MIN_RATIO, not demanded — see
    // repairMutedForActiveRow's own doc comment — but must never regress
    // below CHM-50's own MUTED_MIN_RATIO guarantee.
    expect(contrastRatio(resolved.subtextHex, resolved.activeRowBackgroundHex)).toBeGreaterThanOrEqual(MUTED_MIN_RATIO);
    // Still below body against ground, and still clears MUTED_MIN_RATIO
    // against every other surface — the cap holds even short of the full
    // TEXT_MIN_RATIO ambition.
    expect(contrastRatio(resolved.subtextHex, AYU_LIGHT.ground)).toBeLessThan(contrastRatio(resolved.textHex, AYU_LIGHT.ground));
    expect(contrastRatio(resolved.subtextHex, AYU_LIGHT.ground)).toBeGreaterThanOrEqual(MUTED_MIN_RATIO);
    expect(contrastRatio(resolved.subtextHex, AYU_LIGHT.selection)).toBeGreaterThanOrEqual(MUTED_MIN_RATIO);
  });

  it("moves the row's own fraction, not muted, when that alone clears both of the row's floors", () => {
    const resolved = resolveActiveRowAndText(MONOKAI_DARK.ground, MONOKAI_DARK.body, MONOKAI_DARK.muted, [MONOKAI_DARK.selection], ACTIVE_ROW_IDEAL_FRACTION);

    expect(resolved.wasVisibilityTraded).toBe(false);
    // Muted itself is untouched — CHM-75's own preferred outcome (see
    // resolveActiveRowAndText's own doc comment): the row's fraction did all
    // the work, and subtext0 never had to move further from ground.
    expect(resolved.subtextHex).toBe(MONOKAI_DARK.muted);
    expect(contrastRatio(resolved.activeRowBackgroundHex, MONOKAI_DARK.ground)).toBeGreaterThanOrEqual(ACTIVE_ROW_MIN_VISIBLE_RATIO);
    // CHM-80: this used to scrape TEXT_MIN_RATIO at 4.63 (see
    // resolveActiveRowBackground's own CHM-80 test above); the smallest-lift
    // row leaves it well past TEXT_MIN_RATIO with margin instead.
    expect(contrastRatio(resolved.subtextHex, resolved.activeRowBackgroundHex)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO * RATIO_CLEARANCE_MARGIN);
    // Still measurably below body against ground, so it keeps reading as
    // muted on every ordinary, unselected row.
    expect(contrastRatio(resolved.subtextHex, MONOKAI_DARK.ground)).toBeLessThan(contrastRatio(resolved.textHex, MONOKAI_DARK.ground));
  });

  // Dracula's own subtext0 (3.03 against ground) is too faint to read
  // against the row even at the smallest fraction that keeps the row
  // visible (2.29) — moving the row alone cannot fix this one, unlike
  // monokai-dark above. subtext0 repairs a second time here, and only here.
  // CHM-75 capped this fixture short of TEXT_MIN_RATIO (its own worked
  // example, ~4.3): CHM-80's lower row floor leaves the row itself so much
  // closer to ground that the second lever now reaches all the way to
  // TEXT_MIN_RATIO with margin instead of being capped short of it.
  it("repairs muted a second time, past its ordinary floor, when moving the row alone cannot make it readable", () => {
    const resolved = resolveActiveRowAndText(DRACULA.ground, DRACULA.body, DRACULA.muted, [DRACULA.selection], ACTIVE_ROW_IDEAL_FRACTION);

    expect(resolved.wasVisibilityTraded).toBe(false);
    expect(resolved.subtextHex).not.toBe(DRACULA.muted);
    expect(contrastRatio(resolved.activeRowBackgroundHex, DRACULA.ground)).toBeGreaterThanOrEqual(ACTIVE_ROW_MIN_VISIBLE_RATIO);
    // Raised well past the 2.29 the row alone left it at, and all the way to
    // TEXT_MIN_RATIO with margin — no longer capped short of it the way
    // CHM-75's own version of this fixture was.
    expect(contrastRatio(resolved.subtextHex, resolved.activeRowBackgroundHex)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO * RATIO_CLEARANCE_MARGIN);
    expect(contrastRatio(resolved.subtextHex, resolved.activeRowBackgroundHex)).toBeGreaterThan(2.29);
    // Still below body against ground — the cap repairMutedForActiveRow
    // holds even when it has to push muted a second time.
    expect(contrastRatio(resolved.subtextHex, DRACULA.ground)).toBeLessThan(contrastRatio(resolved.textHex, DRACULA.ground));
    // And it still clears MUTED_MIN_RATIO against every other surface it
    // was already reading fine against.
    expect(contrastRatio(resolved.subtextHex, DRACULA.ground)).toBeGreaterThanOrEqual(MUTED_MIN_RATIO);
    expect(contrastRatio(resolved.subtextHex, DRACULA.selection)).toBeGreaterThanOrEqual(MUTED_MIN_RATIO);
  });

  // Every one of the 606 schemes vendored from mbadolato/iTerm2-Color-Schemes
  // — not just the 29 curated packs this library ships — clears both hard
  // floors (row-vs-ground, and subtext0-vs-row at least MUTED_MIN_RATIO) at
  // the row's own visibility target without ever reaching the retreat
  // fallback. This is CHM-33's own warning taken seriously in the other
  // direction: rather than asserting an impossibility band exists somewhere
  // without proof, this proves the band this ticket is actually worried
  // about (a pack needing to trade row visibility away) is empty across
  // every real scheme available to this project. wasVisibilityTraded's own
  // retreat branch exists for a pack this project does not have a fixture
  // for, and is documented, not fabricated, in palette/surfaces.ts.
  it("never trades row visibility away for either of this ticket's own named worst cases", () => {
    for (const scheme of [readVendoredScheme("Dracula.json"), readVendoredScheme("Ayu Light.json")]) {
      const roleHexes = resolveRoleHexes(scheme);
      const { selection, body } = resolveSelectionAndBody(
        scheme.selectionBackground,
        roleHexes.ground,
        roleHexes.body,
        roleHexes.accent,
        [roleHexes.success, roleHexes.error],
      );
      const resolved = resolveActiveRowAndText(roleHexes.ground, body.hex, roleHexes.muted, [selection.hex], ACTIVE_ROW_IDEAL_FRACTION);
      expect(resolved.wasVisibilityTraded).toBe(false);
    }
  });
});

// CHM-79: the declared contrast inventory — every (foreground, background)
// pair a target actually renders, named once, gated together (see this
// module's own "declared contrast inventory" section). checkContrastPairs
// itself is trivial; what matters is that the inventory a target builds
// names the pairs CHM-79's own ticket body lists, holds each to the right
// floor, and refuses to run at all when a token shows up that inventory
// does not know about.

describe("checkContrastPairs", () => {
  it("reports a pair whose measured ratio falls under its own declared floor, and omits one that clears it", () => {
    const pairs = [
      { label: "passing", foregroundHex: "#ffffff", backgroundHex: "#000000", minRatio: TEXT_MIN_RATIO, kind: "text" as const },
      { label: "failing", foregroundHex: "#333333", backgroundHex: "#222222", minRatio: TEXT_MIN_RATIO, kind: "text" as const },
    ];

    const failures = checkContrastPairs(pairs);

    expect(failures).toHaveLength(1);
    expect(failures[0]?.pair.label).toBe("failing");
    expect(failures[0]?.ratio).toBeLessThan(TEXT_MIN_RATIO);
  });
});

describe("windowsTerminalContrastPairs", () => {
  // Ayu Light's own authored cursor measures 1.80 against its own
  // background — under even ANSI_MIN_RATIO, and nothing before CHM-79 ever
  // checked it: cursorColor is not one of the 16 ANSI slots, and it carried
  // no pair of its own at all.
  it("flags an unrepaired cursorColor against background, and clears once repaired — Ayu Light's own authored cursor", () => {
    const scheme = readVendoredScheme("Ayu Light.json");
    expect(contrastRatio(scheme.cursorColor, scheme.background)).toBeLessThan(ANSI_MIN_RATIO);

    const failuresBefore = checkContrastPairs(windowsTerminalContrastPairs(scheme));
    expect(failuresBefore.some((failure) => failure.pair.label === "windows-terminal cursorColor on background")).toBe(true);

    const repairedScheme = { ...scheme, cursorColor: repairCursorColor(scheme.cursorColor, scheme.background) };
    const failuresAfter = checkContrastPairs(windowsTerminalContrastPairs(repairedScheme));
    expect(failuresAfter.some((failure) => failure.pair.label === "windows-terminal cursorColor on background")).toBe(false);
  });

  it("holds every one of the 16 ANSI slots and the cursor to ANSI_MIN_RATIO, and foreground to TEXT_MIN_RATIO against both background and selectionBackground", () => {
    const scheme = readVendoredScheme("Dracula.json");
    const pairs = windowsTerminalContrastPairs(scheme);

    const cursorPair = pairs.find((pair) => pair.label === "windows-terminal cursorColor on background");
    expect(cursorPair?.minRatio).toBe(ANSI_MIN_RATIO);
    expect(cursorPair?.kind).toBe("visibility");

    const foregroundPairs = pairs.filter((pair) => pair.label.startsWith("windows-terminal foreground on"));
    expect(foregroundPairs).toHaveLength(2);
    for (const pair of foregroundPairs) {
      expect(pair.minRatio).toBe(TEXT_MIN_RATIO);
      expect(pair.kind).toBe("text");
    }

    const ansiSlotPairs = pairs.filter((pair) => pair.label.endsWith(" on background") && pair.label !== "windows-terminal cursorColor on background" && pair.label !== "windows-terminal foreground on background");
    expect(ansiSlotPairs).toHaveLength(16);
    for (const pair of ansiSlotPairs) {
      expect(pair.minRatio).toBe(ANSI_MIN_RATIO);
      expect(pair.kind).toBe("visibility");
    }
  });
});

describe("herdrContrastPairs", () => {
  // Monokai Classic's own real ANSI slots and resolved roles — the same
  // pipeline theme-pack.ts's buildThemePack runs, reproduced here so this
  // suite works from real values rather than invented ones.
  const monokaiScheme = readVendoredScheme("Monokai Classic.json");
  const monokaiRoleHexes = resolveRoleHexes(monokaiScheme);
  const monokaiSelectionAndBody = resolveSelectionAndBody(
    monokaiScheme.selectionBackground,
    monokaiRoleHexes.ground,
    monokaiRoleHexes.body,
    monokaiRoleHexes.accent,
    [monokaiRoleHexes.success, monokaiRoleHexes.error],
  );
  const monokaiRowAndText = resolveActiveRowAndText(
    monokaiRoleHexes.ground,
    monokaiSelectionAndBody.body.hex,
    monokaiRoleHexes.muted,
    [monokaiSelectionAndBody.selection.hex],
    ACTIVE_ROW_IDEAL_FRACTION,
  );
  const monokaiBadgeTokens = resolveHerdrBadgeTokens(monokaiScheme);

  function monokaiTokens(overrides: Partial<HerdrTokenSet> = {}): HerdrTokenSet {
    return {
      sidebar_bg: monokaiRoleHexes.ground,
      panel_bg: monokaiRoleHexes.ground,
      active_row_bg: monokaiRowAndText.activeRowBackgroundHex,
      selection_bg: monokaiSelectionAndBody.selection.hex,
      text: monokaiRowAndText.textHex,
      subtext0: monokaiRowAndText.subtextHex,
      overlay0: repairOverlay0(
        mix(monokaiRoleHexes.ground, monokaiSelectionAndBody.body.hex, OVERLAY_0_FRACTION),
        monokaiRoleHexes.ground,
        monokaiRowAndText.activeRowBackgroundHex,
      ),
      accent: monokaiRoleHexes.accent,
      green: monokaiRoleHexes.success,
      red: monokaiRoleHexes.error,
      ...monokaiBadgeTokens,
      ...overrides,
    };
  }

  it("throws, naming the token, when fed a key it has no declared pair or exemption for", () => {
    const tokensWithUnknownKey = { ...monokaiTokens(), "some-future-token": "#123456" } as unknown as HerdrTokenSet;

    expect(() => herdrContrastPairs(tokensWithUnknownKey)).toThrow(/some-future-token/);
  });

  it("never throws for the four ramp steps that carry no text — they are declared exempt, not forgotten", () => {
    const tokensWithRampSteps: HerdrTokenSet = {
      ...monokaiTokens(),
      surface_dim: "#101010",
      surface0: "#202020",
      surface1: "#303030",
      overlay1: "#404040",
    };

    expect(() => herdrContrastPairs(tokensWithRampSteps)).not.toThrow();
  });

  it("holds the three Chameleon roles (accent, green, red) to TEXT_MIN_RATIO, and the four badge swatches to ANSI_MIN_RATIO instead — CHM-79's own stated exemption", () => {
    const pairs = herdrContrastPairs(monokaiTokens());

    for (const role of ["accent", "green", "red"]) {
      const rolePairs = pairs.filter((pair) => pair.label.startsWith(`herdr ${role} on`));
      expect(rolePairs).toHaveLength(2);
      for (const pair of rolePairs) {
        expect(pair.minRatio).toBe(TEXT_MIN_RATIO);
        expect(pair.kind).toBe("text");
      }
    }

    for (const badgeToken of ["yellow", "blue", "teal", "mauve", "peach"]) {
      const badgePairs = pairs.filter((pair) => pair.label.startsWith(`herdr ${badgeToken} on`));
      expect(badgePairs).toHaveLength(2);
      for (const pair of badgePairs) {
        expect(pair.minRatio).toBe(ANSI_MIN_RATIO);
        expect(pair.kind).toBe("visibility");
      }
    }
  });

  it("holds selection_bg against sidebar_bg to SELECTION_MIN_VISIBLE_RATIO, as a highlight pair rather than text", () => {
    const pairs = herdrContrastPairs(monokaiTokens());
    const selectionPair = pairs.find((pair) => pair.label === "herdr selection_bg on sidebar_bg");

    expect(selectionPair?.minRatio).toBe(SELECTION_MIN_VISIBLE_RATIO);
    expect(selectionPair?.kind).toBe("visibility");
    expect(checkContrastPairs(herdrContrastPairs(monokaiTokens()))).not.toContainEqual(
      expect.objectContaining({ pair: expect.objectContaining({ label: "herdr selection_bg on sidebar_bg" }) }),
    );
  });

  // CHM-78's own reported bug, reproduced here as the regression proof CHM-79
  // asks for: "the gate fails when run against the pre-CHM-78 overlay0
  // value". #b6b7ac is the plain, unrepaired ramp value (ground/body mixed
  // at OVERLAY_0_FRACTION) monokai-dark's own overlay0 measured before
  // CHM-78's repairOverlay0 existed — 3.45 against active_row_bg #585a52,
  // short of TEXT_MIN_RATIO even though overlay0 paints real text there (see
  // palette/surfaces.ts's repairOverlay0 and this ticket's own body).
  // #585a52 was monokai-dark's own active_row_bg as CHM-78 shipped it — kept
  // as a fixed historical value here, alongside the pre-repair overlay0,
  // since CHM-80 changed resolveActiveRowAndText's own output for this
  // scheme to a background the pre-CHM-78 candidate no longer fails against
  // (proving the gate still catches the pair it exists for does not require
  // reproducing the original bug from today's live pipeline).
  it("fails overlay0-on-active_row_bg when fed the pre-CHM-78, unrepaired ramp value — proving the gate catches the bug it exists for", () => {
    const preCHM80ActiveRowHex = "#585a52";
    const preRepairOverlay0 = mix(monokaiRoleHexes.ground, monokaiSelectionAndBody.body.hex, OVERLAY_0_FRACTION);
    expect(contrastRatio(preRepairOverlay0, preCHM80ActiveRowHex)).toBeLessThan(TEXT_MIN_RATIO);

    const failures = checkContrastPairs(herdrContrastPairs(monokaiTokens({ overlay0: preRepairOverlay0, active_row_bg: preCHM80ActiveRowHex })));
    const overlay0OnRow = failures.find((failure) => failure.pair.label === "herdr overlay0 on active_row_bg");

    expect(overlay0OnRow).toBeDefined();
    expect(overlay0OnRow?.ratio).toBeLessThan(TEXT_MIN_RATIO);

    // The real, repaired value (what adapters/herdr.ts and theme-pack.ts
    // both actually ship today, against today's own active_row_bg) clears
    // the same pair, with far more margin than the historical pair above
    // ever had.
    const failuresAfterRepair = checkContrastPairs(herdrContrastPairs(monokaiTokens()));
    expect(failuresAfterRepair.some((failure) => failure.pair.label === "herdr overlay0 on active_row_bg")).toBe(false);
  });

  it("holds text and overlay0 to TEXT_MIN_RATIO and subtext0 to MUTED_MIN_RATIO, each against sidebar_bg, panel_bg and active_row_bg — CHM-79's own known Herdr pairs", () => {
    const pairs = herdrContrastPairs(monokaiTokens());
    const textBearingSurfaces = ["sidebar_bg", "panel_bg", "active_row_bg"];

    for (const foregroundToken of ["text", "overlay0"]) {
      const tokenPairs = textBearingSurfaces.map((surface) => pairs.find((pair) => pair.label === `herdr ${foregroundToken} on ${surface}`));
      expect(tokenPairs.every((pair) => pair !== undefined)).toBe(true);
      for (const pair of tokenPairs) expect(pair?.minRatio).toBe(TEXT_MIN_RATIO);
    }

    const subtextPairs = textBearingSurfaces.map((surface) => pairs.find((pair) => pair.label === `herdr subtext0 on ${surface}`));
    expect(subtextPairs.every((pair) => pair !== undefined)).toBe(true);
    for (const pair of subtextPairs) expect(pair?.minRatio).toBe(MUTED_MIN_RATIO);
  });
});

// CHM-80: subtext0-on-row asserted for every one of the 29 bundled packs
// together, dark and light alike — light packs invert which direction the
// row's fraction moves (CHM-30 already found the unreachable cases live on
// that side), so a fix proven only against dark packs would not prove
// anything about them. Recomputed directly from each pack's own committed
// windows-terminal payload, the same real, generated-and-committed 29
// theme-pack.test.ts's own suites read — not a re-derived copy.
describe("subtext0-on-row clears TEXT_MIN_RATIO, dark and light packs alike (CHM-80)", () => {
  // ayu-light, everforest-light and tokyo-night-light are the three whose
  // own body clears ground by too little (6.12, 6.13, 6.11) to leave muted
  // room to also clear TEXT_MIN_RATIO and stay measurably below body at
  // once — CHM-30's own kind of unreachable case, on this pair instead of
  // selection-vs-ground. Each still lands within 0.06 of the floor, not the
  // ~0.2 gap CHM-75 shipped: see the per-pack fixture table in
  // herdr.test.ts's own CHM-50/CHM-75/CHM-80 suite.
  const PACKS_BELOW_TEXT_MIN_RATIO = new Set(["ayu-light", "everforest-light", "tokyo-night-light"]);

  // A margin comfortably past rounding-safety (RATIO_CLEARANCE_MARGIN's own
  // territory) — a whole point of contrast above the floor, not a hair over
  // it. 4.63 (the value monokai-dark shipped before this ticket) clears
  // TEXT_MIN_RATIO itself but would fail this bar, which is the point: this
  // is the "with margin, not by scraping it" acceptance bar, not the floor
  // every pack outside the three named exceptions already had to clear.
  const COMFORTABLE_MARGIN_ABOVE_TEXT_MIN_RATIO = 1;

  function subtextOnRowFor(slug: string): number {
    const pack = loadCuratedThemePacks().find((candidate) => candidate.manifest.slug === slug);
    if (!pack) throw new Error(`fixture pack not found: ${slug}`);

    const scheme = pack.payloads["windows-terminal"];
    const roleHexes = resolveRoleHexes(scheme);
    const { selection, body } = resolveSelectionAndBody(
      scheme.selectionBackground,
      roleHexes.ground,
      roleHexes.body,
      roleHexes.accent,
      [roleHexes.success, roleHexes.error],
    );
    const resolved = resolveActiveRowAndText(roleHexes.ground, body.hex, roleHexes.muted, [selection.hex], ACTIVE_ROW_IDEAL_FRACTION);
    return contrastRatio(resolved.subtextHex, resolved.activeRowBackgroundHex);
  }

  it("clears TEXT_MIN_RATIO for every bundled pack outside the three named exceptions", () => {
    const packs = loadCuratedThemePacks();
    expect(packs.length).toBe(29);

    for (const pack of packs) {
      if (PACKS_BELOW_TEXT_MIN_RATIO.has(pack.manifest.slug)) continue;
      expect(subtextOnRowFor(pack.manifest.slug), pack.manifest.slug).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
    }
  });

  // monokai-dark by name — this ticket's own reported bug — proving the fix
  // is not just legal but no longer scraping the floor: the shipped value
  // this ticket exists to fix (4.63) fails the margin below, even though it
  // already cleared TEXT_MIN_RATIO itself.
  it("clears TEXT_MIN_RATIO with a comfortable margin for monokai-dark — fails on the shipped value of 4.63", () => {
    const oldShippedMonokaiDarkValue = 4.63;
    expect(oldShippedMonokaiDarkValue).toBeLessThan(TEXT_MIN_RATIO + COMFORTABLE_MARGIN_ABOVE_TEXT_MIN_RATIO);

    expect(subtextOnRowFor("monokai-dark")).toBeGreaterThanOrEqual(TEXT_MIN_RATIO + COMFORTABLE_MARGIN_ABOVE_TEXT_MIN_RATIO);
  });

  // Both appearances, asserted explicitly rather than only inside the loop
  // above, so a change that keeps every dark pack passing while quietly
  // breaking every light one (or vice versa) fails a test by name.
  // one-half-light is the light pack: its own body clears ground with far
  // more headroom (8.27) than the three named exceptions' own 6.1-ish, so
  // the same comfortable margin is reachable on the light side too.
  it("clears TEXT_MIN_RATIO with a comfortable margin for a dark pack (monokai-dark) and a light pack (one-half-light)", () => {
    expect(subtextOnRowFor("monokai-dark")).toBeGreaterThanOrEqual(TEXT_MIN_RATIO + COMFORTABLE_MARGIN_ABOVE_TEXT_MIN_RATIO);
    expect(subtextOnRowFor("one-half-light")).toBeGreaterThanOrEqual(TEXT_MIN_RATIO + COMFORTABLE_MARGIN_ABOVE_TEXT_MIN_RATIO);
  });

  it("still lands within 0.06 of TEXT_MIN_RATIO for the three named exceptions, not silently short of it", () => {
    for (const slug of PACKS_BELOW_TEXT_MIN_RATIO) {
      const subtextOnRow = subtextOnRowFor(slug);
      expect(subtextOnRow, slug).toBeLessThan(TEXT_MIN_RATIO);
      expect(subtextOnRow, slug).toBeGreaterThan(TEXT_MIN_RATIO - 0.06);
    }
  });

  it("clears row-vs-sidebar visibility for every bundled pack — the row is still a visibly distinct band, not just a text-legibility fix", () => {
    for (const pack of loadCuratedThemePacks()) {
      const scheme = pack.payloads["windows-terminal"];
      const roleHexes = resolveRoleHexes(scheme);
      const { selection, body } = resolveSelectionAndBody(
        scheme.selectionBackground,
        roleHexes.ground,
        roleHexes.body,
        roleHexes.accent,
        [roleHexes.success, roleHexes.error],
      );
      const resolved = resolveActiveRowAndText(roleHexes.ground, body.hex, roleHexes.muted, [selection.hex], ACTIVE_ROW_IDEAL_FRACTION);
      expect(contrastRatio(resolved.activeRowBackgroundHex, roleHexes.ground), pack.manifest.slug).toBeGreaterThanOrEqual(ACTIVE_ROW_MIN_VISIBLE_RATIO);
    }
  });
});
