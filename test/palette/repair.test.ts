import { beforeAll, describe, expect, it } from "vitest";
import { MIN_REPAIRED_CHROMA, MUTED_MIN_RATIO, ROLES, TEXT_MIN_RATIO } from "../../src/constants.js";
import { chromaOf, toHsl } from "../../src/palette/color.js";
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

  // These four candidates have no lightness headroom left in the direction
  // their repair needs: pushed to their floor by lightness alone, each is
  // driven to a white or black that clears the ratio but loses its colour
  // entirely (Acid Lime's success measured a chroma of 0.004, on a 0-1
  // scale, before this trade existed). Real values, not invented — see
  // CHM-17.
  it.each([
    ["Acid Lime", "success"],
    ["Hot Dog Stand", "success"],
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
    }
  });

  it("never repairs a role below MIN_REPAIRED_CHROMA without reporting it as a fallback, for every vendored scheme", () => {
    for (const palette of palettes) {
      const assignment = assignRolesByContrast(palette);
      const report = repairFailingRoles(assignment);

      for (const role of ROLES) {
        const resolved = report.palette[role];
        if (!resolved.wasRepaired || resolved.isFallback) continue;

        expect(
          chromaOf(resolved.hex),
          `${palette.name}: ${role} repaired to ${resolved.hex} without clearing the chroma floor or falling back`,
        ).toBeGreaterThanOrEqual(MIN_REPAIRED_CHROMA);
      }
    }
  });
});
