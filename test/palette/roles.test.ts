import { beforeAll, describe, expect, it } from "vitest";
import type { Palette } from "../../src/palette/palette.js";
import { assignRolesByContrast } from "../../src/palette/roles.js";
import { loadVendoredSchemes } from "../../src/palette/scheme-library.js";

// Every fixture below is a real vendored Windows Terminal scheme, loaded
// through the same loader the shipped themes go through — never invented
// hex. See vendor/iterm2-color-schemes/windows-terminal/<name>.json.
let palettes: Palette[];

function paletteNamed(name: string): Palette {
  const palette = palettes.find((candidate) => candidate.name === name);
  if (!palette) throw new Error(`fixture scheme not found: ${name}`);
  return palette;
}

beforeAll(() => {
  palettes = loadVendoredSchemes();
});

describe("assignRolesByContrast", () => {
  it("assigns ground and body to the scheme's background and foreground", () => {
    const assignment = assignRolesByContrast(paletteNamed("iTerm2 Solarized Dark"));
    expect(assignment.ground.slot).toBe("background");
    expect(assignment.body.slot).toBe("foreground");
  });

  it("measures Solarized Dark's muted (brightBlack) at 2.11 against ground, below the 3.0 floor", () => {
    const assignment = assignRolesByContrast(paletteNamed("iTerm2 Solarized Dark"));
    expect(assignment.muted.slot).toBe("brightBlack");
    expect(assignment.muted.contrastRatio).toBeCloseTo(2.11, 2);
  });

  it("measures Ayu Mirage's muted at 2.78, below the 3.0 floor", () => {
    const assignment = assignRolesByContrast(paletteNamed("Ayu Mirage"));
    expect(assignment.muted.contrastRatio).toBeCloseTo(2.78, 2);
  });

  it("measures Kanagawa Lotus's muted at 2.93, below the 3.0 floor", () => {
    const assignment = assignRolesByContrast(paletteNamed("Kanagawa Lotus"));
    expect(assignment.muted.contrastRatio).toBeCloseTo(2.93, 2);
  });

  it("measures Solarized Light's muted at 13.92, outranking its own body at 4.13", () => {
    const assignment = assignRolesByContrast(paletteNamed("iTerm2 Solarized Light"));
    expect(assignment.muted.contrastRatio).toBeCloseTo(13.92, 2);
    expect(assignment.body.contrastRatio).toBeCloseTo(4.13, 2);
    expect(assignment.muted.contrastRatio).toBeGreaterThan(assignment.body.contrastRatio);
  });

  it("flags Gruvbox Dark's accent as weak at 3.48, below the 4.5 floor", () => {
    const assignment = assignRolesByContrast(paletteNamed("Gruvbox Dark"));
    expect(assignment.accent.contrastRatio).toBeCloseTo(3.48, 2);
  });

  it("flags Gruvbox Light's accent as weak at 3.73, below the 4.5 floor", () => {
    const assignment = assignRolesByContrast(paletteNamed("Gruvbox Light"));
    expect(assignment.accent.contrastRatio).toBeCloseTo(3.73, 2);
  });

  it("never picks Gruvbox's cyan slot for accent, because it measures as a green hue, not cool", () => {
    // Gruvbox's `cyan` slot (#689d6a) is a muted green, not a cyan — the
    // slot name is not trustworthy here.
    const assignment = assignRolesByContrast(paletteNamed("Gruvbox Dark"));
    expect(assignment.accent.slot).not.toBe("cyan");
  });

  it("detects Night Owlish Light's purple/foreground collision: both measure #403f53", () => {
    const assignment = assignRolesByContrast(paletteNamed("Night Owlish Light"));
    expect(assignment.accent.slot).toBe("purple");
    expect(assignment.accent.hex).toBe("#403f53");
    expect(assignment.body.hex).toBe("#403f53");
  });
});
