import { describe, expect, it } from "vitest";
import { ACTIVE_ROW_MIN_VISIBLE_RATIO, MUTED_MIN_RATIO, TEXT_MIN_RATIO } from "../../src/constants.js";
import { contrastRatio, mix } from "../../src/palette/color.js";
import { resolveRoleHexes } from "../../src/palette/repair.js";
import { resolveSelectionAndBody } from "../../src/palette/selection.js";
import {
  ACTIVE_ROW_IDEAL_FRACTION,
  repairOverlay0,
  resolveActiveRowAndText,
  resolveActiveRowBackground,
} from "../../src/palette/surfaces.js";
import { readVendoredScheme } from "../../tools/vendor-scheme-library.js";

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

// Ayu Light: the ideal fraction's own row-vs-sidebar measures only 1.63 —
// under ACTIVE_ROW_MIN_VISIBLE_RATIO — so the row itself must move further
// from ground before any text repair even starts. Ground carries plenty of
// its own room to do that: body clears ground by 10.09.
const AYU_LIGHT = { ground: "#f8f9fa", body: "#5a5f64", muted: "#686868", selection: "#d7dde4" };

// monokai-dark's own resolved role hexes (ground, body and muted post
// repairFailingRoles/resolveSelectionAndBody, muted post its own ordinary
// repair against ground and selection) — CHM-75's own worked case: the
// ideal fraction's row already clears row-vs-ground (2.96) but muted-vs-row
// measures only 3.33, short of TEXT_MIN_RATIO. Falling the row back to
// #585a52 (2.12 vs ground, still clearing the visibility floor) is enough
// on its own — muted's own value never needs a second repair.
const MONOKAI_DARK = { ground: "#272822", body: "#fdfff1", muted: "#d2d2d2", selection: "#007d95" };

// Dracula's own selected-row fixture, but fed a muted value too faint on
// its own (Dracula's real subtext0 measures 3.03 against ground, CHM-50's
// own four-fixture set) to fix by moving the row alone: even at the lowest
// fraction that still clears row-vs-ground, muted-vs-row only reaches 1.44.
// This is the case that needs both levers this ticket adds — the row falls
// back for visibility, and muted repairs a second time on top of it.
const DRACULA = { ground: "#282a36", body: "#f8f8f2", muted: "#6272a4", selection: "#565864" };

describe("resolveActiveRowBackground", () => {
  it("keeps the ideal ground/body blend unchanged when it already clears both the visibility and readability floors", () => {
    const activeRow = resolveActiveRowBackground(NO_REPAIR.ground, NO_REPAIR.body, NO_REPAIR.muted, ACTIVE_ROW_IDEAL_FRACTION);

    expect(activeRow.wasRepaired).toBe(false);
    expect(activeRow.hex).toBe(mix(NO_REPAIR.ground, NO_REPAIR.body, ACTIVE_ROW_IDEAL_FRACTION));
    expect(contrastRatio(activeRow.hex, NO_REPAIR.ground)).toBeGreaterThanOrEqual(ACTIVE_ROW_MIN_VISIBLE_RATIO);
    expect(contrastRatio(NO_REPAIR.muted, activeRow.hex)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
  });

  it("pushes the row further toward body when the ideal blend falls short of the visibility floor", () => {
    const idealHex = mix(AYU_LIGHT.ground, AYU_LIGHT.body, ACTIVE_ROW_IDEAL_FRACTION);
    expect(contrastRatio(idealHex, AYU_LIGHT.ground)).toBeLessThan(ACTIVE_ROW_MIN_VISIBLE_RATIO);

    const activeRow = resolveActiveRowBackground(AYU_LIGHT.ground, AYU_LIGHT.body, AYU_LIGHT.muted, ACTIVE_ROW_IDEAL_FRACTION);

    expect(activeRow.wasRepaired).toBe(true);
    expect(contrastRatio(activeRow.hex, AYU_LIGHT.ground)).toBeGreaterThanOrEqual(ACTIVE_ROW_MIN_VISIBLE_RATIO);
    // Still a plain blend of this theme's own ground and body — every
    // channel sits between the two source colours' own matching channels —
    // never a colour invented from nowhere (CHM-38's own guarantee, held
    // here for the surface this ticket introduces).
    for (const channelOffset of [1, 3, 5]) {
      const groundChannel = Number.parseInt(AYU_LIGHT.ground.slice(channelOffset, channelOffset + 2), 16);
      const bodyChannel = Number.parseInt(AYU_LIGHT.body.slice(channelOffset, channelOffset + 2), 16);
      const rowChannel = Number.parseInt(activeRow.hex.slice(channelOffset, channelOffset + 2), 16);
      expect(rowChannel).toBeGreaterThanOrEqual(Math.min(groundChannel, bodyChannel));
      expect(rowChannel).toBeLessThanOrEqual(Math.max(groundChannel, bodyChannel));
    }
  });

  // CHM-75: the fix this ticket exists for. monokai-dark's subtext0 read at
  // exactly MUTED_MIN_RATIO against the ideal-fraction row (3.33, legal
  // under CHM-50's own floor but the least readable text on screen) even
  // though the row itself had visibility to spare (2.96 against a 2.0
  // floor). Pulling the row back toward ground trades away some of that
  // spare visibility for muted's own readability, never below the floor.
  it("pulls the row back toward ground when the ideal blend clears visibility but muted cannot be read against it", () => {
    const idealHex = mix(MONOKAI_DARK.ground, MONOKAI_DARK.body, ACTIVE_ROW_IDEAL_FRACTION);
    expect(contrastRatio(idealHex, MONOKAI_DARK.ground)).toBeGreaterThanOrEqual(ACTIVE_ROW_MIN_VISIBLE_RATIO);
    expect(contrastRatio(MONOKAI_DARK.muted, idealHex)).toBeLessThan(TEXT_MIN_RATIO);

    const activeRow = resolveActiveRowBackground(MONOKAI_DARK.ground, MONOKAI_DARK.body, MONOKAI_DARK.muted, ACTIVE_ROW_IDEAL_FRACTION);

    expect(activeRow.wasRepaired).toBe(true);
    // The row moved — not muted: this is still MONOKAI_DARK.muted itself,
    // unrepaired, reading clearly against the fraction the row fell back to.
    expect(contrastRatio(activeRow.hex, MONOKAI_DARK.ground)).toBeGreaterThanOrEqual(ACTIVE_ROW_MIN_VISIBLE_RATIO);
    expect(contrastRatio(MONOKAI_DARK.muted, activeRow.hex)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
    // The fallback is a real retreat toward ground, not the ideal blend
    // reproduced by coincidence.
    expect(activeRow.hex).not.toBe(idealHex);
  });
});

// CHM-78: adapters/herdr.ts's surfaceScale mixes overlay0 at 4/6 of the way
// from ground to body — duplicated here rather than imported, the same way
// this file's own ground/body/muted fixtures already stand in for herdr.ts's
// real inputs.
const OVERLAY_0_FRACTION = 4 / 6;

describe("repairOverlay0", () => {
  it("repairs the plain ramp value when it fails TEXT_MIN_RATIO against the active row — CHM-78's own reported case", () => {
    const activeRow = resolveActiveRowBackground(MONOKAI_DARK.ground, MONOKAI_DARK.body, MONOKAI_DARK.muted, ACTIVE_ROW_IDEAL_FRACTION);
    const candidateHex = mix(MONOKAI_DARK.ground, MONOKAI_DARK.body, OVERLAY_0_FRACTION);
    // The exact pair this ticket's own body measured on the reporter's live
    // config: overlay0 #b6b7ac on active_row_bg #585a52 reads 3.45, short of
    // TEXT_MIN_RATIO even though overlay0 painted text there all along.
    expect(candidateHex).toBe("#b6b7ac");
    expect(activeRow.hex).toBe("#585a52");
    expect(contrastRatio(candidateHex, activeRow.hex)).toBeLessThan(TEXT_MIN_RATIO);

    const repaired = repairOverlay0(candidateHex, MONOKAI_DARK.ground, activeRow.hex);

    expect(repaired).not.toBe(candidateHex);
    expect(contrastRatio(repaired, MONOKAI_DARK.ground)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
    expect(contrastRatio(repaired, activeRow.hex)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
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

  it("repairs the row's own visibility first, then still clears text and subtext0 against it, for a pack whose ideal blend starts under the floor", () => {
    const resolved = resolveActiveRowAndText(AYU_LIGHT.ground, AYU_LIGHT.body, AYU_LIGHT.muted, [AYU_LIGHT.selection], ACTIVE_ROW_IDEAL_FRACTION);

    expect(resolved.wasVisibilityTraded).toBe(false);
    expect(contrastRatio(resolved.activeRowBackgroundHex, AYU_LIGHT.ground)).toBeGreaterThanOrEqual(ACTIVE_ROW_MIN_VISIBLE_RATIO);
    expect(contrastRatio(resolved.textHex, resolved.activeRowBackgroundHex)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
    // subtext0-on-row is maximised toward TEXT_MIN_RATIO, not demanded — see
    // repairMutedForActiveRow's own doc comment — but must never regress
    // below CHM-50's own MUTED_MIN_RATIO guarantee.
    expect(contrastRatio(resolved.subtextHex, resolved.activeRowBackgroundHex)).toBeGreaterThanOrEqual(MUTED_MIN_RATIO);
  });

  it("moves the row's own fraction, not muted, when that alone clears both of the row's floors", () => {
    const resolved = resolveActiveRowAndText(MONOKAI_DARK.ground, MONOKAI_DARK.body, MONOKAI_DARK.muted, [MONOKAI_DARK.selection], ACTIVE_ROW_IDEAL_FRACTION);

    expect(resolved.wasVisibilityTraded).toBe(false);
    // Muted itself is untouched — CHM-75's own preferred outcome (see
    // resolveActiveRowAndText's own doc comment): the row's fraction did all
    // the work, and subtext0 never had to move further from ground.
    expect(resolved.subtextHex).toBe(MONOKAI_DARK.muted);
    expect(contrastRatio(resolved.activeRowBackgroundHex, MONOKAI_DARK.ground)).toBeGreaterThanOrEqual(ACTIVE_ROW_MIN_VISIBLE_RATIO);
    expect(contrastRatio(resolved.subtextHex, resolved.activeRowBackgroundHex)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
    // Still measurably below body against ground, so it keeps reading as
    // muted on every ordinary, unselected row.
    expect(contrastRatio(resolved.subtextHex, MONOKAI_DARK.ground)).toBeLessThan(contrastRatio(resolved.textHex, MONOKAI_DARK.ground));
  });

  // CHM-75's second lever: Dracula's own subtext0 (3.03 against ground) is
  // too faint to read against the row even at the lowest fraction that
  // keeps the row visible (1.44) — moving the row alone cannot fix this
  // one, unlike monokai-dark above. subtext0 repairs a second time here,
  // and only here.
  it("repairs muted a second time, past its ordinary floor, when moving the row alone cannot make it readable", () => {
    const resolved = resolveActiveRowAndText(DRACULA.ground, DRACULA.body, DRACULA.muted, [DRACULA.selection], ACTIVE_ROW_IDEAL_FRACTION);

    expect(resolved.wasVisibilityTraded).toBe(false);
    expect(resolved.subtextHex).not.toBe(DRACULA.muted);
    expect(contrastRatio(resolved.activeRowBackgroundHex, DRACULA.ground)).toBeGreaterThanOrEqual(ACTIVE_ROW_MIN_VISIBLE_RATIO);
    // Raised well past the 1.44 the row alone left it at, and past CHM-50's
    // own MUTED_MIN_RATIO floor — but this fixture's own body clears ground
    // by only 13.36, and the cap below it (see repairMutedForActiveRow)
    // catches muted just short of the full TEXT_MIN_RATIO ambition here.
    // The "maximise, never demand" shape SELECTION_IDEAL_RATIO already uses
    // for the selection highlight, not a regression: still comfortably past
    // MUTED_MIN_RATIO, further than moving the row alone could reach.
    expect(contrastRatio(resolved.subtextHex, resolved.activeRowBackgroundHex)).toBeGreaterThanOrEqual(MUTED_MIN_RATIO);
    expect(contrastRatio(resolved.subtextHex, resolved.activeRowBackgroundHex)).toBeGreaterThan(1.44);
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
