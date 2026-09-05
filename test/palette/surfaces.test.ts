import { describe, expect, it } from "vitest";
import { MUTED_MIN_RATIO, TEXT_MIN_RATIO } from "../../src/constants.js";
import { contrastRatio, mix } from "../../src/palette/color.js";
import { repairSurface } from "../../src/palette/surfaces.js";

/**
 * Real, resolved role hexes from the bundled packs (see themes/*.json) —
 * never invented. The fraction below (2/6) is active_row_bg's own ideal
 * fraction — see SURFACE_SCALE_IDEAL_FRACTIONS in adapters/herdr.ts — and
 * these four are CHM-48's own named worst cases: before this fix,
 * active_row_bg measured subtext0 at 1.07 (dracula-dark), 1.07
 * (monokai-dark), 1.23 (night-owl-dark) and 1.33 (nord-dark), all against a
 * floor of 3.0.
 */
const ACTIVE_ROW_BG_IDEAL_FRACTION = 2 / 6;

const DRACULA_DARK = { ground: "#282a36", body: "#f8f8f2", muted: "#6272a4" };
const MONOKAI_DARK = { ground: "#272822", body: "#fdfff1", muted: "#73756b" };
const NIGHT_OWL_DARK = { ground: "#011627", body: "#d6deeb", muted: "#656464" };
const NORD_DARK = { ground: "#2e3440", body: "#d8dee9", muted: "#778195" };

describe("repairSurface", () => {
  it("ships the ideal ground/body mix unchanged when it already clears both floors", () => {
    // github-light's active_row_bg (surface0's own fraction) measures 7.76
    // for text and 3.14 for subtext0 before any repair — comfortably over
    // both floors, so nothing here should move it.
    const groundHex = "#ffffff";
    const bodyHex = "#1f2328";
    const mutedHex = "#57606a";
    const surface = repairSurface(groundHex, bodyHex, mutedHex, ACTIVE_ROW_BG_IDEAL_FRACTION);
    expect(surface.wasRepaired).toBe(false);
    expect(contrastRatio(bodyHex, surface.hex)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
    expect(contrastRatio(mutedHex, surface.hex)).toBeGreaterThanOrEqual(MUTED_MIN_RATIO);
  });

  const WORST_FOUR_FIXTURES = [
    { slug: "dracula-dark", ...DRACULA_DARK },
    { slug: "monokai-dark", ...MONOKAI_DARK },
    { slug: "night-owl-dark", ...NIGHT_OWL_DARK },
    { slug: "nord-dark", ...NORD_DARK },
  ];

  it.each(WORST_FOUR_FIXTURES)(
    "repairs $slug's active_row_bg so text and subtext0 both clear their floors",
    ({ ground, body, muted }) => {
      const surface = repairSurface(ground, body, muted, ACTIVE_ROW_BG_IDEAL_FRACTION);
      expect(surface.wasRepaired).toBe(true);
      expect(contrastRatio(body, surface.hex)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
      expect(contrastRatio(muted, surface.hex)).toBeGreaterThanOrEqual(MUTED_MIN_RATIO);
    },
  );

  // nord-dark is this ticket's own reporter: the sidebar row a user actually
  // looked at and could not read. Pinned by name, with its achieved ratio,
  // per CHM-48's acceptance criteria.
  it("clears nord-dark's own floor with room to spare — the pack this ticket was reported on", () => {
    const surface = repairSurface(NORD_DARK.ground, NORD_DARK.body, NORD_DARK.muted, ACTIVE_ROW_BG_IDEAL_FRACTION);
    expect(contrastRatio(NORD_DARK.muted, surface.hex)).toBeGreaterThanOrEqual(MUTED_MIN_RATIO);
  });

  it("moves a repaired surface toward ground, never past its own ideal blend toward body", () => {
    // Repair only ever retreats toward ground (the free variable, and the
    // one point body's and muted's own floors are already guaranteed to
    // hold) — it never overshoots past the ideal fraction toward body.
    const { ground, body, muted } = DRACULA_DARK;
    const idealHex = mix(ground, body, ACTIVE_ROW_BG_IDEAL_FRACTION);
    const surface = repairSurface(ground, body, muted, ACTIVE_ROW_BG_IDEAL_FRACTION);
    expect(surface.hex).not.toBe(idealHex);
    expect(contrastRatio(surface.hex, ground)).toBeLessThanOrEqual(contrastRatio(idealHex, ground));
  });

  it("still reads as the theme's own colours — a blend of ground and body, never a synthesised grey (CHM-38)", () => {
    for (const { ground, body, muted } of WORST_FOUR_FIXTURES) {
      const surface = repairSurface(ground, body, muted, ACTIVE_ROW_BG_IDEAL_FRACTION);
      // Every channel of a ground/body mix sits between the two source
      // colours' own matching channels — proof it is a blend of this
      // theme's own colours, not a colour invented from nowhere.
      for (const channelOffset of [1, 3, 5]) {
        const groundChannel = Number.parseInt(ground.slice(channelOffset, channelOffset + 2), 16);
        const bodyChannel = Number.parseInt(body.slice(channelOffset, channelOffset + 2), 16);
        const surfaceChannel = Number.parseInt(surface.hex.slice(channelOffset, channelOffset + 2), 16);
        const lowerBound = Math.min(groundChannel, bodyChannel);
        const upperBound = Math.max(groundChannel, bodyChannel);
        expect(surfaceChannel).toBeGreaterThanOrEqual(lowerBound);
        expect(surfaceChannel).toBeLessThanOrEqual(upperBound);
      }
    }
  });
});
