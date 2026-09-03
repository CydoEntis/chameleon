import { describe, expect, it } from "vitest";
import { contrastRatio, fromHsl, relativeLuminance, toHsl } from "../../src/palette/color.js";

describe("relativeLuminance", () => {
  it("gives black a relative luminance of 0", () => {
    expect(relativeLuminance("#000000")).toBe(0);
  });

  it("gives white a relative luminance of 1", () => {
    expect(relativeLuminance("#ffffff")).toBe(1);
  });

  it("matches the WCAG value for Catppuccin Mocha's background", () => {
    // #1e1e2e is Catppuccin Mocha's real background — see the vendored
    // scheme at vendor/iterm2-color-schemes/windows-terminal/Catppuccin Mocha.json.
    expect(relativeLuminance("#1e1e2e")).toBeCloseTo(0.014018225783409327, 10);
  });

  it("matches the WCAG value for Gruvbox Light's background", () => {
    // #fbf1c7 is Gruvbox Light's real background.
    expect(relativeLuminance("#fbf1c7")).toBeCloseTo(0.8754334472439043, 10);
  });

  it("is case-insensitive on hex digits", () => {
    expect(relativeLuminance("#1E1E2E")).toBe(relativeLuminance("#1e1e2e"));
  });

  it("rejects a string that is not a 6-digit hex colour", () => {
    expect(() => relativeLuminance("not-a-colour")).toThrow(/hex colour/);
  });
});

describe("contrastRatio", () => {
  it("gives black against white the maximum WCAG ratio of 21", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 10);
  });

  it("gives a colour against itself a ratio of 1", () => {
    expect(contrastRatio("#1e1e2e", "#1e1e2e")).toBe(1);
  });

  it("does not depend on argument order", () => {
    expect(contrastRatio("#1e1e2e", "#cdd6f4")).toBe(contrastRatio("#cdd6f4", "#1e1e2e"));
  });

  it("matches the known ratio between Catppuccin Mocha's background and foreground", () => {
    // #1e1e2e and #cdd6f4 are Catppuccin Mocha's real background and
    // foreground — see the vendored scheme at
    // vendor/iterm2-color-schemes/windows-terminal/Catppuccin Mocha.json.
    expect(contrastRatio("#1e1e2e", "#cdd6f4")).toBeCloseTo(11.341133436863977, 10);
  });

  it("matches the known ratio between iTerm2 Solarized Dark's background and foreground", () => {
    expect(contrastRatio("#002b36", "#839496")).toBeCloseTo(4.747877839876171, 10);
  });
});

describe("toHsl", () => {
  it("gives pure red a hue of 0 at full saturation and mid lightness", () => {
    expect(toHsl("#ff0000")).toEqual({ hue: 0, saturation: 100, lightness: 50 });
  });

  it("gives black and white zero saturation", () => {
    expect(toHsl("#000000")).toEqual({ hue: 0, saturation: 0, lightness: 0 });
    expect(toHsl("#ffffff")).toEqual({ hue: 0, saturation: 0, lightness: 100 });
  });
});

describe("fromHsl", () => {
  it("round-trips pure red", () => {
    expect(fromHsl({ hue: 0, saturation: 100, lightness: 50 })).toBe("#ff0000");
  });

  it("is the inverse of toHsl for a real scheme colour", () => {
    // #268bd2 is iTerm2 Solarized Dark's real blue slot.
    const hsl = toHsl("#268bd2");
    expect(fromHsl(hsl)).toBe("#268bd2");
  });
});
