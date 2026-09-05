import { beforeAll, describe, expect, it } from "vitest";
import { MIN_REPAIRED_CHROMA, MUTED_MIN_RATIO, ROLES, SELECTION_MIN_RATIO, TEXT_MIN_RATIO } from "../../src/constants.js";
import { chromaOf, contrastRatio, toHsl } from "../../src/palette/color.js";
import type { Palette } from "../../src/palette/palette.js";
import { repairFailingRoles } from "../../src/palette/repair.js";
import { assignRolesByContrast } from "../../src/palette/roles.js";
import { loadVendoredSchemes } from "../../tools/vendor-scheme-library.js";

// Real vendored schemes only — see roles.test.ts and
// vendor/iterm2-color-schemes/windows-terminal/<name>.json.
let palettes: Palette[];

function paletteNamed(name: string): Palette {
  const palette = palettes.find((candidate) => candidate.name === name);
  if (!palette) throw new Error(`fixture scheme not found: ${name}`);
  return palette;
}

/** The hue tolerance a repaired colour must stay within of its pre-repair hue, in degrees. */
const HUE_TOLERANCE_DEGREES = 3;

beforeAll(() => {
  palettes = loadVendoredSchemes();
});

describe("repairFailingRoles", () => {
  it("leaves ground untouched and unrepaired", () => {
    const assignment = assignRolesByContrast(paletteNamed("iTerm2 Solarized Dark"));
    const report = repairFailingRoles(assignment);
    expect(report.palette.ground.hex).toBe(assignment.ground.hex);
    expect(report.palette.ground.wasRepaired).toBe(false);
  });

  it("repairs Solarized Dark's muted so it clears the 3.0 floor", () => {
    const assignment = assignRolesByContrast(paletteNamed("iTerm2 Solarized Dark"));
    const report = repairFailingRoles(assignment);
    expect(report.repairedRoles).toContain("muted");
    expect(report.palette.muted.contrastRatio).toBeGreaterThanOrEqual(MUTED_MIN_RATIO);
  });

  it("repairs Ayu Mirage's muted so it clears the 3.0 floor", () => {
    const assignment = assignRolesByContrast(paletteNamed("Ayu Mirage"));
    const report = repairFailingRoles(assignment);
    expect(report.palette.muted.contrastRatio).toBeGreaterThanOrEqual(MUTED_MIN_RATIO);
  });

  it("repairs Kanagawa Lotus's muted so it clears the 3.0 floor", () => {
    const assignment = assignRolesByContrast(paletteNamed("Kanagawa Lotus"));
    const report = repairFailingRoles(assignment);
    expect(report.palette.muted.contrastRatio).toBeGreaterThanOrEqual(MUTED_MIN_RATIO);
  });

  it("repairs Solarized Light's inversion so muted sits below body, not above it", () => {
    const assignment = assignRolesByContrast(paletteNamed("iTerm2 Solarized Light"));
    const report = repairFailingRoles(assignment);
    expect(report.repairedRoles).toContain("muted");
    expect(report.palette.muted.contrastRatio).toBeGreaterThanOrEqual(MUTED_MIN_RATIO);
    expect(report.palette.muted.contrastRatio).toBeLessThan(report.palette.body.contrastRatio);
  });

  it("repairs Gruvbox Dark's weak accent to clear the 4.5 floor", () => {
    const assignment = assignRolesByContrast(paletteNamed("Gruvbox Dark"));
    const report = repairFailingRoles(assignment);
    expect(report.repairedRoles).toContain("accent");
    expect(report.palette.accent.contrastRatio).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
  });

  it("repairs Gruvbox Light's weak accent to clear the 4.5 floor", () => {
    const assignment = assignRolesByContrast(paletteNamed("Gruvbox Light"));
    const report = repairFailingRoles(assignment);
    expect(report.palette.accent.contrastRatio).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
  });

  it("preserves Gruvbox Dark accent's hue within tolerance while repairing its lightness", () => {
    const assignment = assignRolesByContrast(paletteNamed("Gruvbox Dark"));
    const report = repairFailingRoles(assignment);
    const hueBefore = toHsl(assignment.accent.hex).hue;
    const hueAfter = toHsl(report.palette.accent.hex).hue;
    expect(Math.abs(hueBefore - hueAfter)).toBeLessThanOrEqual(HUE_TOLERANCE_DEGREES);
  });

  // A repair that walks a fixed-saturation lightness line to the first
  // colour that clears its floor runs straight through white or black —
  // HSL saturation stays at 100% as lightness nears either pole even while
  // the colour's actual chroma collapses to nothing. These three each need
  // real contrast (Acid Lime's success and Thayer Bright's error only
  // clear their floor by outranking a same-hex sibling role; Fairyfloss's
  // error starts below its own floor) and each still measures a chroma
  // well above MIN_REPAIRED_CHROMA once repaired: 0.52, 0.55 and 0.24
  // respectively. See CHM-20.
  it.each([
    ["Acid Lime", "success"],
    ["Thayer Bright", "error"],
    ["Fairyfloss", "error"],
  ] as const)("keeps %s's %s recognisably coloured instead of washing it to white or black", (schemeName, role) => {
    const assignment = assignRolesByContrast(paletteNamed(schemeName));
    const report = repairFailingRoles(assignment);
    const repaired = report.palette[role];

    expect(report.repairedRoles).toContain(role);
    expect(repaired.isFallback).toBe(false);
    expect(chromaOf(repaired.hex)).toBeGreaterThanOrEqual(MIN_REPAIRED_CHROMA);
    expect(repaired.contrastRatio).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
  });

  it("carves Hot Dog Stand's success out as a deliberate grey fallback, not a failure", () => {
    // Hot Dog Stand's #ea3323 background makes a saturated 4.5:1 colour
    // impossible: the best any hue can reach while holding
    // MIN_REPAIRED_CHROMA against it is 4.19. Falling back to a computed
    // near-black is the correct outcome here, and repair reports it as
    // exactly that rather than silently shipping it as an ordinary repair.
    const assignment = assignRolesByContrast(paletteNamed("Hot Dog Stand"));
    const report = repairFailingRoles(assignment);
    const repaired = report.palette.success;

    expect(report.fallbackRoles).toContain("success");
    expect(repaired.isFallback).toBe(true);
    expect(repaired.contrastRatio).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
  });

  it("repairs Night Owlish Light's purple/foreground collision to two distinct colours", () => {
    const assignment = assignRolesByContrast(paletteNamed("Night Owlish Light"));
    expect(assignment.accent.hex).toBe(assignment.body.hex); // the collision, unrepaired
    const report = repairFailingRoles(assignment);
    expect(report.repairedRoles).toContain("accent");
    expect(report.palette.accent.hex).not.toBe(report.palette.body.hex);
    expect(report.palette.accent.contrastRatio).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
  });

  it("every role in the repaired palette is frozen", () => {
    const assignment = assignRolesByContrast(paletteNamed("iTerm2 Solarized Dark"));
    const report = repairFailingRoles(assignment);
    expect(Object.isFrozen(report.palette)).toBe(true);
    for (const role of ROLES) {
      expect(Object.isFrozen(report.palette[role])).toBe(true);
    }
  });

  it("passes every floor, for every vendored scheme, after repair", () => {
    for (const palette of palettes) {
      const assignment = assignRolesByContrast(palette);
      const report = repairFailingRoles(assignment);

      expect(report.palette.body.contrastRatio, `${palette.name}: body`).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
      expect(report.palette.accent.contrastRatio, `${palette.name}: accent`).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
      expect(report.palette.success.contrastRatio, `${palette.name}: success`).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
      expect(report.palette.error.contrastRatio, `${palette.name}: error`).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
      expect(report.palette.muted.contrastRatio, `${palette.name}: muted floor`).toBeGreaterThanOrEqual(
        MUTED_MIN_RATIO,
      );
      expect(report.palette.muted.contrastRatio, `${palette.name}: muted below body`).toBeLessThan(
        report.palette.body.contrastRatio,
      );
      // Selection's ground-visibility floor is the one guarantee every
      // vendored scheme gets, same as every other role — see
      // repairSelection's own doc comment for why its second floor, body
      // legibility, cannot make the same unconditional promise.
      expect(report.palette.selection.contrastRatio, `${palette.name}: selection vs ground`).toBeGreaterThanOrEqual(
        SELECTION_MIN_RATIO,
      );
    }
  });

  // CHM-26: one-half-light's shipped selection (#bfceff on #fafafa) was the
  // bug report itself, measured at 1.49 — invisible in practice.
  it("repairs one-half-light's selection to clear both floors: visible against ground, and keeps body legible on top of it", () => {
    const assignment = assignRolesByContrast(paletteNamed("One Half Light"));
    const report = repairFailingRoles(assignment);

    expect(report.repairedRoles).toContain("selection");
    expect(report.palette.selection.contrastRatio).toBeGreaterThanOrEqual(SELECTION_MIN_RATIO);
    expect(contrastRatio(report.palette.body.hex, report.palette.selection.hex)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
  });

  // Solarized Dark's own body (#839496) sits only 4.75 from ground
  // (#002b36) — its own deliberately low-contrast design, and below
  // SELECTION_MIN_RATIO × TEXT_MIN_RATIO, the contrast a selection colour
  // between the two would need to clear both floors at once (see
  // repairSelection's own doc comment). No colour clears both here; ground's
  // floor — the one guarantee every other role also makes — still holds.
  it("still clears selection's ground floor for Solarized Dark, whose body sits too close to ground to also keep it legible", () => {
    const assignment = assignRolesByContrast(paletteNamed("iTerm2 Solarized Dark"));
    const report = repairFailingRoles(assignment);

    expect(report.repairedRoles).toContain("selection");
    expect(report.palette.selection.contrastRatio).toBeGreaterThanOrEqual(SELECTION_MIN_RATIO);
    expect(contrastRatio(report.palette.body.hex, report.palette.selection.hex)).toBeLessThan(TEXT_MIN_RATIO);
  });
});
