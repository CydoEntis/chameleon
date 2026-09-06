import { describe, expect, it } from "vitest";
import { SELECTION_HUE_MIN_DISTANCE_DEGREES, SELECTION_IDEAL_RATIO, SELECTION_MAX_CHROMA, SELECTION_MIN_RESOLVED_CHROMA, SELECTION_MIN_VISIBLE_RATIO, TEXT_MIN_RATIO } from "../../src/constants.js";
import { chromaOf, contrastRatio, hueDistanceDegrees, toHsl } from "../../src/palette/color.js";
import { resolveSelectionAndBody } from "../../src/palette/selection.js";

// Real vendored/bundled values (mbadolato/iTerm2-Color-Schemes, via
// themes/*.json) — never invented hex. See code-standards.md, "Colour tests
// use real schemes' real values". `accent`/`success`/`error` are each
// scheme's own resolved roles (resolveRoleHexes), the same three
// resolveSelectionAndBody now needs to choose a repaired selection's hue —
// see chooseSelectionHue.

// Gruvbox Dark: this ticket's (CHM-76) own named fixture. selectionBackground
// clears both of resolveSelectionAndBody's contrast floors as authored
// (selection-vs-ground 2.26, body-on-selection 4.75 — see
// themes/gruvbox-dark.json's pre-fix history) — the exact case CHM-70 never
// reached, because its tint only ran once a repair had already fired. But
// its chroma is 0.071: grey-on-grey to the eye despite clearing both floors,
// which are built on luminance alone. Below SELECTION_MIN_RESOLVED_CHROMA,
// so CHM-76 retints it via chooseSelectionHue same as a contrast repair.
const GRUVBOX_DARK = { ground: "#282828", body: "#ebdbb2", selection: "#665c54", accent: "#5d9da0", success: "#689d6a", error: "#ff5750" };

// Monokai Classic: this ticket's other own named fixture, and the more
// extreme case — selectionBackground clears both floors even more
// comfortably than Gruvbox Dark's (selection-vs-ground 2.06, body-on-
// selection 7.12) while carrying almost no chroma at all (0.035, the
// lowest of any of the 29 bundled packs' authored candidates).
const MONOKAI_DARK = { ground: "#272822", body: "#fdfff1", selection: "#57584f", accent: "#66d9ef", success: "#a6e22e", error: "#e6db74" };

// Jellybeans: the control case CHM-76 must not touch. selectionBackground
// clears both contrast floors as authored (selection-vs-ground 2.47,
// body-on-selection 5.64) and already carries real chroma (0.290, close to
// the ~0.55 mean across the 29 bundled packs) — well above
// SELECTION_MIN_RESOLVED_CHROMA, so this is kept exactly as authored rather
// than retinted toward accent for no reason.
const JELLYBEANS = { ground: "#121212", body: "#dedede", selection: "#474e91", accent: "#e1c0fa", success: "#94b979", error: "#e27373" };

// Dracula: selectionBackground clears the hard floor easily (8.59) but only
// measures 1.56 for selection-vs-ground — short of SELECTION_IDEAL_RATIO —
// and body clears ground by 13.36, comfortably enough room to reach it.
// Accent (190.5°) sits 40.9° from ground's own hue (231.4°) — clear of
// SELECTION_HUE_MIN_DISTANCE_DEGREES, so the repair uses it directly.
const DRACULA = { ground: "#282a36", body: "#f8f8f2", selection: "#44475a", accent: "#8be9fd", success: "#f1fa8c", error: "#ff5555" };

// Rosé Pine Dawn: selectionBackground clears the hard floor (5.25) but only
// measures 1.27 for selection-vs-ground. Ground and body clear each other by
// only 6.66 — enough room to beat 1.27, but not enough to also reach
// SELECTION_IDEAL_RATIO (2.0) alongside the hard floor.
const ROSE_PINE_DAWN = { ground: "#faf4ed", body: "#575279", selection: "#dfdad9", accent: "#286983", success: "#1e5f79", error: "#a95450" };

// GitHub Light: selectionBackground is literally its own body colour —
// contrast 1.0, invisible as a highlight and unreadable underneath it at
// once (see herdr.test.ts's GITHUB_LIGHT_SCHEME). Ground/body clear each
// other by 15.8, comfortably enough room to reach SELECTION_IDEAL_RATIO
// alongside the hard floor.
const GITHUB_LIGHT = { ground: "#ffffff", body: "#1f2328", selection: "#1f2328", accent: "#0969da", success: "#116329", error: "#cf222e" };

// Solarized Light: ground and body clear each other by only 4.69 — one of
// the 10 packs CHM-30's own worked proof names as unable to clear
// SELECTION_IDEAL_RATIO and the hard floor at once. Even the best
// achievable selection-vs-ground here falls short of
// SELECTION_MIN_VISIBLE_RATIO once rounding safety is folded in, so body
// itself must move — see themes/solarized-light.json's own selection_bg.
const SOLARIZED_LIGHT = { ground: "#fdf6e3", body: "#5b7179", selection: "#eee8d5", accent: "#c92c78", success: "#667600", error: "#d42a27" };

// Solarized Dark: this ticket's own named fixture. selectionBackground
// measures 1.15 for selection-vs-ground and 4.11 for body-on-selection —
// short of both floors, so repair kicks in. Ground carries plenty of its
// own chroma (0.212, a saturated blue-cyan), but before CHM-38 the repair
// searched a hue-free grey and landed on pure black (see themes/
// solarized-dark.json's history) — a black slab on a blue-cyan background.
// Accent (175.5°) sits only 16.8° from ground's own hue (192.2°) — inside
// SELECTION_HUE_MIN_DISTANCE_DEGREES, so CHM-70's own fallback fires and
// error's hue (168.8° from ground) is used instead.
const SOLARIZED_DARK = { ground: "#002b36", body: "#839496", selection: "#073642", accent: "#2aa198", success: "#859900", error: "#ff5552" };

/** Resolves one of the fixtures above, threading its accent/success/error through to resolveSelectionAndBody's own hue-choosing parameters. */
function resolve(fixture: { ground: string; body: string; selection: string; accent: string; success: string; error: string }) {
  return resolveSelectionAndBody(fixture.selection, fixture.ground, fixture.body, fixture.accent, [fixture.success, fixture.error]);
}

describe("resolveSelectionAndBody", () => {
  it("keeps a selection that already clears the hard floor, the ideal ratio and the chroma floor untouched", () => {
    const { selection, body } = resolve(JELLYBEANS);

    expect(selection.hex).toBe(JELLYBEANS.selection);
    expect(selection.wasRepaired).toBe(false);
    expect(body.wasNudged).toBe(false);
  });

  // CHM-76: an authored selection can clear both contrast floors and still
  // be invisible, because contrast is a function of luminance alone and has
  // no notion of colour — CHM-70's tint only ran once a repair had already
  // fired, so a candidate like these two shipped exactly as authored.
  it("retints Gruvbox Dark's selection despite it clearing both contrast floors, because its chroma (0.071) is below SELECTION_MIN_RESOLVED_CHROMA", () => {
    const { selection } = resolve(GRUVBOX_DARK);

    // The authored candidate really did clear both floors — this is not the
    // DRACULA/ROSE_PINE_DAWN case of a candidate failing on contrast.
    expect(contrastRatio(GRUVBOX_DARK.selection, GRUVBOX_DARK.ground)).toBeGreaterThanOrEqual(SELECTION_IDEAL_RATIO);
    expect(contrastRatio(GRUVBOX_DARK.body, GRUVBOX_DARK.selection)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
    expect(chromaOf(GRUVBOX_DARK.selection)).toBeLessThan(SELECTION_MIN_RESOLVED_CHROMA);

    expect(selection.wasRepaired).toBe(true);
    expect(selection.hex).not.toBe(GRUVBOX_DARK.selection);
    expect(chromaOf(selection.hex)).toBeGreaterThanOrEqual(SELECTION_MIN_RESOLVED_CHROMA);
    expect(chromaOf(selection.hex)).toBeCloseTo(0.42, 2);
    expect(contrastRatio(GRUVBOX_DARK.body, selection.hex)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
    expect(selection.selectionVsGroundRatio).toBeGreaterThanOrEqual(SELECTION_MIN_VISIBLE_RATIO);
  });

  it("retints Monokai Classic's selection despite it clearing both contrast floors even more comfortably, because its chroma (0.035) is the lowest of any bundled pack", () => {
    const { selection } = resolve(MONOKAI_DARK);

    expect(contrastRatio(MONOKAI_DARK.selection, MONOKAI_DARK.ground)).toBeGreaterThanOrEqual(SELECTION_IDEAL_RATIO);
    expect(contrastRatio(MONOKAI_DARK.body, MONOKAI_DARK.selection)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
    expect(chromaOf(MONOKAI_DARK.selection)).toBeLessThan(SELECTION_MIN_RESOLVED_CHROMA);

    expect(selection.wasRepaired).toBe(true);
    expect(selection.hex).not.toBe(MONOKAI_DARK.selection);
    expect(chromaOf(selection.hex)).toBeGreaterThanOrEqual(SELECTION_MIN_RESOLVED_CHROMA);
    expect(chromaOf(selection.hex)).toBeCloseTo(0.58, 2);
    expect(contrastRatio(MONOKAI_DARK.body, selection.hex)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
    expect(selection.selectionVsGroundRatio).toBeGreaterThanOrEqual(SELECTION_MIN_VISIBLE_RATIO);
  });

  it("repairs a selection short of the ideal ratio up to it, when ground and body leave room", () => {
    const { selection, body } = resolve(DRACULA);

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
    const { selection, body } = resolve(ROSE_PINE_DAWN);

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
    const { selection, body } = resolve(SOLARIZED_LIGHT);

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
    const { selection } = resolve(JELLYBEANS);

    expect(selection.selectionVsGroundRatio).toBeCloseTo(contrastRatio(JELLYBEANS.selection, JELLYBEANS.ground), 5);
  });

  it("repairs a selection identical to body into one clearing both the hard floor and (up to rounding) the ideal ratio", () => {
    const { selection } = resolve(GITHUB_LIGHT);

    expect(selection.wasRepaired).toBe(true);
    expect(selection.hex).not.toBe(GITHUB_LIGHT.selection);
    expect(contrastRatio(selection.hex, GITHUB_LIGHT.ground)).toBeGreaterThan(SELECTION_IDEAL_RATIO - 0.05);
    expect(contrastRatio(GITHUB_LIGHT.body, selection.hex)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
  });

  it("repairs Solarized Dark's selection into a tint of accent's own hue rather than the pure black CHM-38 named (ground carries 0.212 of its own chroma)", () => {
    const { selection } = resolve(SOLARIZED_DARK);

    expect(selection.wasRepaired).toBe(true);
    expect(selection.hex).not.toBe("#000000");
    expect(chromaOf(selection.hex)).toBeGreaterThan(SELECTION_MAX_CHROMA);
    expect(contrastRatio(SOLARIZED_DARK.body, selection.hex)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
    expect(selection.selectionVsGroundRatio).toBeGreaterThanOrEqual(SELECTION_MIN_VISIBLE_RATIO);
  });

  it("falls back to error's hue for Solarized Dark, since accent (175.5°) sits only 16.8° from ground's own hue (192.2°) — inside SELECTION_HUE_MIN_DISTANCE_DEGREES", () => {
    const { selection } = resolve(SOLARIZED_DARK);

    expect(selection.usedFallbackHue).toBe(true);
    const groundHue = toHsl(SOLARIZED_DARK.ground).hue;
    const errorHue = toHsl(SOLARIZED_DARK.error).hue;
    expect(hueDistanceDegrees(toHsl(selection.hex).hue, groundHue)).toBeCloseTo(hueDistanceDegrees(errorHue, groundHue), 0);
  });

  it("uses accent's own hue directly for Dracula, since it clears SELECTION_HUE_MIN_DISTANCE_DEGREES from ground on its own", () => {
    const { selection } = resolve(DRACULA);

    expect(selection.usedFallbackHue).toBe(false);
    const groundHue = toHsl(DRACULA.ground).hue;
    const accentHue = toHsl(DRACULA.accent).hue;
    expect(hueDistanceDegrees(accentHue, groundHue)).toBeGreaterThanOrEqual(SELECTION_HUE_MIN_DISTANCE_DEGREES);
    expect(hueDistanceDegrees(toHsl(selection.hex).hue, groundHue)).toBeCloseTo(hueDistanceDegrees(accentHue, groundHue), 0);
  });
});
