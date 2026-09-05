import { describe, expect, it } from "vitest";
import { SELECTION_IDEAL_RATIO, SELECTION_MIN_CHROMA, SELECTION_MIN_VISIBLE_RATIO, TEXT_MIN_RATIO } from "../../src/constants.js";
import { chromaOf, contrastRatio } from "../../src/palette/color.js";
import { resolveSelectionAndBody } from "../../src/palette/selection.js";

// Real vendored/bundled values (mbadolato/iTerm2-Color-Schemes, via
// themes/*.json) — never invented hex. See code-standards.md, "Colour tests
// use real schemes' real values".

// Gruvbox Dark: selectionBackground already clears both the hard floor and
// SELECTION_IDEAL_RATIO as authored (selection-vs-ground 2.26,
// body-on-selection 4.75 — see themes/gruvbox-dark.json).
const GRUVBOX_DARK = { ground: "#282828", body: "#ebdbb2", selection: "#665c54" };

// Dracula: selectionBackground clears the hard floor easily (8.59) but only
// measures 1.56 for selection-vs-ground — short of SELECTION_IDEAL_RATIO —
// and body clears ground by 13.36, comfortably enough room to reach it.
const DRACULA = { ground: "#282a36", body: "#f8f8f2", selection: "#44475a" };

// Rosé Pine Dawn: selectionBackground clears the hard floor (5.25) but only
// measures 1.27 for selection-vs-ground. Ground and body clear each other by
// only 6.66 — enough room to beat 1.27, but not enough to also reach
// SELECTION_IDEAL_RATIO (2.0) alongside the hard floor.
const ROSE_PINE_DAWN = { ground: "#faf4ed", body: "#575279", selection: "#dfdad9" };

// GitHub Light: selectionBackground is literally its own body colour —
// contrast 1.0, invisible as a highlight and unreadable underneath it at
// once (see herdr.test.ts's GITHUB_LIGHT_SCHEME). Ground/body clear each
// other by 15.8, comfortably enough room to reach SELECTION_IDEAL_RATIO
// alongside the hard floor.
const GITHUB_LIGHT = { ground: "#ffffff", body: "#1f2328", selection: "#1f2328" };

// Solarized Light: ground and body clear each other by only 4.69 — one of
// the 10 packs CHM-30's own worked proof names as unable to clear
// SELECTION_IDEAL_RATIO and the hard floor at once. Even the best
// achievable selection-vs-ground here falls short of
// SELECTION_MIN_VISIBLE_RATIO once rounding safety is folded in, so body
// itself must move — see themes/solarized-light.json's own selection_bg.
const SOLARIZED_LIGHT = { ground: "#fdf6e3", body: "#5b7179", selection: "#eee8d5" };

// Solarized Dark: this ticket's own named fixture. selectionBackground
// measures 1.15 for selection-vs-ground and 4.11 for body-on-selection —
// short of both floors, so repair kicks in. Ground carries plenty of its
// own chroma (0.212, a saturated blue-cyan), but before CHM-38 the repair
// searched a hue-free grey and landed on pure black (see themes/
// solarized-dark.json's history) — a black slab on a blue-cyan background.
const SOLARIZED_DARK = { ground: "#002b36", body: "#839496", selection: "#073642" };

describe("resolveSelectionAndBody", () => {
  it("keeps a selection that already clears the hard floor and the ideal ratio untouched", () => {
    const { selection, body } = resolveSelectionAndBody(GRUVBOX_DARK.selection, GRUVBOX_DARK.ground, GRUVBOX_DARK.body);

    expect(selection.hex).toBe(GRUVBOX_DARK.selection);
    expect(selection.wasRepaired).toBe(false);
    expect(body.wasNudged).toBe(false);
  });

  it("repairs a selection short of the ideal ratio up to it, when ground and body leave room", () => {
    const { selection, body } = resolveSelectionAndBody(DRACULA.selection, DRACULA.ground, DRACULA.body);

    expect(selection.wasRepaired).toBe(true);
    expect(selection.hex).not.toBe(DRACULA.selection);
    expect(contrastRatio(DRACULA.body, selection.hex)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
    // Reaches for SELECTION_IDEAL_RATIO — landing a hair under it is just
    // 8-bit rounding on the final hex, not a shortfall in the search itself.
    expect(contrastRatio(selection.hex, DRACULA.ground)).toBeGreaterThan(SELECTION_IDEAL_RATIO - 0.05);
    expect(selection.selectionVsGroundRatio).toBeCloseTo(contrastRatio(selection.hex, DRACULA.ground), 5);
    expect(body.wasNudged).toBe(false);
  });

  it("caps selection-vs-ground at the best this ground/body pair allows, without touching body, when that is still visible", () => {
    // Rosé Pine Dawn's ground/body pair cannot host a colour clearing both
    // the hard floor and SELECTION_IDEAL_RATIO at once, but the best it can
    // do (1.40) already clears SELECTION_MIN_VISIBLE_RATIO — so body is left
    // exactly as it was, and the highlight gets as visible as the pair
    // allows instead of failing outright.
    const { selection, body } = resolveSelectionAndBody(ROSE_PINE_DAWN.selection, ROSE_PINE_DAWN.ground, ROSE_PINE_DAWN.body);

    expect(selection.wasRepaired).toBe(true);
    expect(contrastRatio(ROSE_PINE_DAWN.body, selection.hex)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
    expect(contrastRatio(selection.hex, ROSE_PINE_DAWN.ground)).toBeGreaterThanOrEqual(SELECTION_MIN_VISIBLE_RATIO);
    expect(contrastRatio(selection.hex, ROSE_PINE_DAWN.ground)).toBeLessThan(SELECTION_IDEAL_RATIO);
    expect(body.wasNudged).toBe(false);
    expect(body.hex).toBe(ROSE_PINE_DAWN.body);
  });

  it("nudges body further from ground when even the best achievable selection would be invisible", () => {
    // Solarized Light's own ground/body pair leaves no selection reaching
    // SELECTION_MIN_VISIBLE_RATIO while clearing the hard floor — CHM-30's
    // named fallback: body moves instead, and that move is reported back
    // rather than done silently.
    const { selection, body } = resolveSelectionAndBody(SOLARIZED_LIGHT.selection, SOLARIZED_LIGHT.ground, SOLARIZED_LIGHT.body);

    expect(body.wasNudged).toBe(true);
    expect(body.hex).not.toBe(SOLARIZED_LIGHT.body);
    // Body only ever moves further from ground, never crosses it or comes
    // back closer — it is still legible against ground, just more so.
    expect(contrastRatio(body.hex, SOLARIZED_LIGHT.ground)).toBeGreaterThanOrEqual(
      contrastRatio(SOLARIZED_LIGHT.body, SOLARIZED_LIGHT.ground),
    );

    expect(contrastRatio(body.hex, selection.hex)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
    expect(selection.selectionVsGroundRatio).toBeGreaterThanOrEqual(SELECTION_MIN_VISIBLE_RATIO);
  });

  it("reports the achieved selection-vs-ground ratio alongside the resolved hex", () => {
    const { selection } = resolveSelectionAndBody(GRUVBOX_DARK.selection, GRUVBOX_DARK.ground, GRUVBOX_DARK.body);

    expect(selection.selectionVsGroundRatio).toBeCloseTo(contrastRatio(GRUVBOX_DARK.selection, GRUVBOX_DARK.ground), 5);
  });

  it("repairs a selection identical to body into one clearing both the hard floor and (up to rounding) the ideal ratio", () => {
    const { selection } = resolveSelectionAndBody(GITHUB_LIGHT.selection, GITHUB_LIGHT.ground, GITHUB_LIGHT.body);

    expect(selection.wasRepaired).toBe(true);
    expect(selection.hex).not.toBe(GITHUB_LIGHT.selection);
    expect(contrastRatio(selection.hex, GITHUB_LIGHT.ground)).toBeGreaterThan(SELECTION_IDEAL_RATIO - 0.05);
    expect(contrastRatio(GITHUB_LIGHT.body, selection.hex)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
  });

  it("repairs Solarized Dark's selection into a tint of ground's own hue rather than the pure black CHM-38 named (ground carries 0.212 of its own chroma)", () => {
    const { selection } = resolveSelectionAndBody(SOLARIZED_DARK.selection, SOLARIZED_DARK.ground, SOLARIZED_DARK.body);

    expect(selection.wasRepaired).toBe(true);
    expect(selection.hex).not.toBe("#000000");
    expect(chromaOf(selection.hex)).toBeGreaterThan(SELECTION_MIN_CHROMA);
    expect(contrastRatio(SOLARIZED_DARK.body, selection.hex)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
    expect(selection.selectionVsGroundRatio).toBeGreaterThanOrEqual(SELECTION_MIN_VISIBLE_RATIO);
  });
});
