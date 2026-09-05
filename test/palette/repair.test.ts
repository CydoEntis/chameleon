import { beforeAll, describe, expect, it } from "vitest";
import { MIN_REPAIRED_CHROMA, MUTED_MIN_RATIO, ROLES, TEXT_MIN_RATIO } from "../../src/constants.js";
import { chromaOf, contrastRatio, toHsl } from "../../src/palette/color.js";
import type { Palette } from "../../src/palette/palette.js";
import { repairFailingRoles, repairForegroundAgainstBackgrounds } from "../../src/palette/repair.js";
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
    }
  });
});

// Real values from Chameleon's own pipeline, not invented: the chips.omp.json
// fixture's "c-badge-text" foreground, and two of its own background keys,
// recoloured against the vendored "everforest-dark" scheme (see
// oh-my-posh.test.ts's CHIPS_FIXTURE_PATH). c-git-normal is what CHM-40's
// git-segment regression rendered against; c-battery-state-error is the
// pairing that actually failed its floor in that run, at 4.41 — this is
// exactly the case CHM-37's own check missed by sampling only one segment.
describe("repairForegroundAgainstBackgrounds", () => {
  const CHIPS_BADGE_TEXT_ON_EVERFOREST_DARK = "#363636";
  const CHIPS_GIT_NORMAL_ON_EVERFOREST_DARK = "#66ffa6";
  const CHIPS_BATTERY_STATE_ERROR_ON_EVERFOREST_DARK = "#e67e80";

  it("leaves a foreground untouched when it already clears the floor against every background", () => {
    expect(
      repairForegroundAgainstBackgrounds(CHIPS_BADGE_TEXT_ON_EVERFOREST_DARK, [CHIPS_GIT_NORMAL_ON_EVERFOREST_DARK], TEXT_MIN_RATIO),
    ).toBeUndefined();
  });

  it("returns undefined, never a same-value repair, when there is no background to check against", () => {
    expect(repairForegroundAgainstBackgrounds(CHIPS_BADGE_TEXT_ON_EVERFOREST_DARK, [], TEXT_MIN_RATIO)).toBeUndefined();
  });

  it("repairs a foreground that fails against one of several real backgrounds, clearing the floor against all of them at once", () => {
    // CHM-40's own regression: this exact foreground already cleared
    // c-git-normal at 9.45, and CHM-37's check stopped there. Paired with
    // c-battery-state-error too — the pairing it never actually renders
    // without — it measured 4.41, under TEXT_MIN_RATIO.
    const backgrounds = [CHIPS_GIT_NORMAL_ON_EVERFOREST_DARK, CHIPS_BATTERY_STATE_ERROR_ON_EVERFOREST_DARK];
    expect(contrastRatio(CHIPS_BADGE_TEXT_ON_EVERFOREST_DARK, CHIPS_BATTERY_STATE_ERROR_ON_EVERFOREST_DARK)).toBeLessThan(TEXT_MIN_RATIO);

    const repaired = repairForegroundAgainstBackgrounds(CHIPS_BADGE_TEXT_ON_EVERFOREST_DARK, backgrounds, TEXT_MIN_RATIO);

    expect(repaired).toBeDefined();
    for (const background of backgrounds) {
      expect(contrastRatio(repaired!, background)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
    }
  });
});
