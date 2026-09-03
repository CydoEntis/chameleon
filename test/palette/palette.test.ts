import { describe, expect, it } from "vitest";
import { toPalette } from "../../src/palette/palette.js";
import { parseScheme } from "../../src/palette/scheme.js";

// Catppuccin Mocha (dark) and Gruvbox Light (light), copied byte-for-byte
// from vendor/iterm2-color-schemes/windows-terminal/ — real schemes, not
// invented fixtures.
const catppuccinMocha = {
  name: "Catppuccin Mocha",
  black: "#45475a",
  red: "#f38ba8",
  green: "#a6e3a1",
  yellow: "#f9e2af",
  blue: "#89b4fa",
  purple: "#f5c2e7",
  cyan: "#94e2d5",
  white: "#bac2de",
  brightBlack: "#585b70",
  brightRed: "#f7aec2",
  brightGreen: "#c2ecbf",
  brightYellow: "#fcd682",
  brightBlue: "#aeccfc",
  brightPurple: "#f398da",
  brightCyan: "#b1eae1",
  brightWhite: "#a6adc8",
  background: "#1e1e2e",
  foreground: "#cdd6f4",
  cursorColor: "#f5e0dc",
  selectionBackground: "#f5e0dc",
};

const gruvboxLight = {
  name: "Gruvbox Light",
  black: "#fbf1c7",
  red: "#cc241d",
  green: "#98971a",
  yellow: "#d79921",
  blue: "#458588",
  purple: "#b16286",
  cyan: "#689d6a",
  white: "#7c6f64",
  brightBlack: "#928374",
  brightRed: "#9d0006",
  brightGreen: "#79740e",
  brightYellow: "#b57614",
  brightBlue: "#076678",
  brightPurple: "#8f3f71",
  brightCyan: "#427b58",
  brightWhite: "#3c3836",
  background: "#fbf1c7",
  foreground: "#3c3836",
  cursorColor: "#3c3836",
  selectionBackground: "#3c3836",
};

describe("toPalette", () => {
  it("carries Catppuccin Mocha's background through unchanged", () => {
    const palette = toPalette(parseScheme(catppuccinMocha));
    expect(palette.slots.background.hex).toBe("#1e1e2e");
  });

  it("derives a dark appearance for Catppuccin Mocha", () => {
    const palette = toPalette(parseScheme(catppuccinMocha));
    expect(palette.appearance).toBe("dark");
  });

  it("derives a light appearance for Gruvbox Light", () => {
    const palette = toPalette(parseScheme(gruvboxLight));
    expect(palette.appearance).toBe("light");
  });

  it("measures and stores relative luminance for every slot", () => {
    const palette = toPalette(parseScheme(catppuccinMocha));

    expect(palette.slots.background.relativeLuminance).toBeCloseTo(
      0.014018225783409327,
      10,
    );
    expect(Object.keys(palette.slots)).toHaveLength(20);
    for (const measuredColor of Object.values(palette.slots)) {
      expect(measuredColor.relativeLuminance).toBeGreaterThanOrEqual(0);
      expect(measuredColor.relativeLuminance).toBeLessThanOrEqual(1);
    }
  });

  it("freezes the returned palette", () => {
    const palette = toPalette(parseScheme(catppuccinMocha));
    // Object.assign's Set always runs with its throw flag on, so this
    // proves the freeze at runtime even though the type is already readonly.
    expect(() => Object.assign(palette, { appearance: "light" })).toThrow();
  });
});
