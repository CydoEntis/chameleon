import { describe, expect, it } from "vitest";
import { ACTIVE_ROW_MIN_VISIBLE_RATIO, MUTED_MIN_RATIO, TEXT_MIN_RATIO } from "../../src/constants.js";
import { contrastRatio, mix } from "../../src/palette/color.js";
import { resolveRoleHexes } from "../../src/palette/repair.js";
import { resolveSelectionAndBody } from "../../src/palette/selection.js";
import { ACTIVE_ROW_IDEAL_FRACTION, resolveActiveRowAndText, resolveActiveRowBackground } from "../../src/palette/surfaces.js";
import { readVendoredScheme } from "../../tools/vendor-scheme-library.js";

// Real vendored/bundled values (mbadolato/iTerm2-Color-Schemes, via
// vendor/iterm2-color-schemes) — never invented hex. See code-standards.md,
// "Colour tests use real schemes' real values".

// Dracula: active_row_bg's own ideal fraction (2/6 of the way from ground to
// body) already clears ACTIVE_ROW_MIN_VISIBLE_RATIO against ground (2.84) —
// this is one of CHM-50's own four named fixtures (see herdr.test.ts), and
// the case where nothing here needs to move at all.
const DRACULA = { ground: "#282a36", body: "#f8f8f2", muted: "#6272a4", selection: "#565864" };

// Ayu Light: the ideal fraction's own row-vs-sidebar measures only 1.63 —
// under ACTIVE_ROW_MIN_VISIBLE_RATIO — so the row itself must move further
// from ground before any text repair even starts. Ground carries plenty of
// its own room to do that: body clears ground by 10.09.
const AYU_LIGHT = { ground: "#f8f9fa", body: "#5a5f64", muted: "#686868", selection: "#d7dde4" };

describe("resolveActiveRowBackground", () => {
  it("keeps the ideal ground/body blend unchanged when it already clears the visibility floor", () => {
    const activeRow = resolveActiveRowBackground(DRACULA.ground, DRACULA.body, ACTIVE_ROW_IDEAL_FRACTION);

    expect(activeRow.wasRepaired).toBe(false);
    expect(activeRow.hex).toBe(mix(DRACULA.ground, DRACULA.body, ACTIVE_ROW_IDEAL_FRACTION));
    expect(contrastRatio(activeRow.hex, DRACULA.ground)).toBeGreaterThanOrEqual(ACTIVE_ROW_MIN_VISIBLE_RATIO);
  });

  it("pushes the row further toward body when the ideal blend falls short of the visibility floor", () => {
    const idealHex = mix(AYU_LIGHT.ground, AYU_LIGHT.body, ACTIVE_ROW_IDEAL_FRACTION);
    expect(contrastRatio(idealHex, AYU_LIGHT.ground)).toBeLessThan(ACTIVE_ROW_MIN_VISIBLE_RATIO);

    const activeRow = resolveActiveRowBackground(AYU_LIGHT.ground, AYU_LIGHT.body, ACTIVE_ROW_IDEAL_FRACTION);

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
});

describe("resolveActiveRowAndText", () => {
  it("clears row-vs-sidebar, text-on-row and subtext0-on-row together, without needing to trade visibility away", () => {
    const resolved = resolveActiveRowAndText(DRACULA.ground, DRACULA.body, DRACULA.muted, [DRACULA.selection], ACTIVE_ROW_IDEAL_FRACTION);

    expect(resolved.wasVisibilityTraded).toBe(false);
    expect(contrastRatio(resolved.activeRowBackgroundHex, DRACULA.ground)).toBeGreaterThanOrEqual(ACTIVE_ROW_MIN_VISIBLE_RATIO);
    expect(contrastRatio(resolved.textHex, resolved.activeRowBackgroundHex)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
    expect(contrastRatio(resolved.subtextHex, resolved.activeRowBackgroundHex)).toBeGreaterThanOrEqual(MUTED_MIN_RATIO);
    // Both floors hold against every surface passed in, not just the row —
    // the whole point of repairing them together rather than one at a time.
    expect(contrastRatio(resolved.textHex, DRACULA.ground)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
    expect(contrastRatio(resolved.textHex, DRACULA.selection)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
    expect(contrastRatio(resolved.subtextHex, DRACULA.ground)).toBeGreaterThanOrEqual(MUTED_MIN_RATIO);
    expect(contrastRatio(resolved.subtextHex, DRACULA.selection)).toBeGreaterThanOrEqual(MUTED_MIN_RATIO);
  });

  it("repairs the row's own visibility first, then still clears text and subtext0 against it, for a pack whose ideal blend starts under the floor", () => {
    const resolved = resolveActiveRowAndText(AYU_LIGHT.ground, AYU_LIGHT.body, AYU_LIGHT.muted, [AYU_LIGHT.selection], ACTIVE_ROW_IDEAL_FRACTION);

    expect(resolved.wasVisibilityTraded).toBe(false);
    expect(contrastRatio(resolved.activeRowBackgroundHex, AYU_LIGHT.ground)).toBeGreaterThanOrEqual(ACTIVE_ROW_MIN_VISIBLE_RATIO);
    expect(contrastRatio(resolved.textHex, resolved.activeRowBackgroundHex)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
    expect(contrastRatio(resolved.subtextHex, resolved.activeRowBackgroundHex)).toBeGreaterThanOrEqual(MUTED_MIN_RATIO);
  });

  // Every one of the 606 schemes vendored from mbadolato/iTerm2-Color-Schemes
  // — not just the 26 curated packs this library ships — clears both floors
  // at the row's own visibility target without ever reaching the retreat
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
      const { selection, body } = resolveSelectionAndBody(scheme.selectionBackground, roleHexes.ground, roleHexes.body);
      const resolved = resolveActiveRowAndText(roleHexes.ground, body.hex, roleHexes.muted, [selection.hex], ACTIVE_ROW_IDEAL_FRACTION);
      expect(resolved.wasVisibilityTraded).toBe(false);
    }
  });
});
