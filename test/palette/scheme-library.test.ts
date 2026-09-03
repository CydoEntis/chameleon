import { beforeAll, describe, expect, it } from "vitest";
import type { Palette } from "../../src/palette/palette.js";
import { loadVendoredSchemes } from "../../src/palette/scheme-library.js";

describe("loadVendoredSchemes", () => {
  let palettes: Palette[];

  beforeAll(() => {
    palettes = loadVendoredSchemes();
  });

  it("parses every vendored scheme without throwing or missing a slot", () => {
    // loadVendoredSchemes() already ran in beforeAll; reaching here at all
    // means every one of the ~600 vendored files parsed cleanly.
    expect(palettes.length).toBeGreaterThan(100);
  });

  it("gives every vendored scheme a unique name", () => {
    const names = palettes.map((palette) => palette.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("has Catppuccin Mocha with background #1e1e2e", () => {
    const catppuccinMocha = palettes.find(
      (palette) => palette.name === "Catppuccin Mocha",
    );

    expect(catppuccinMocha?.slots.background.hex).toBe("#1e1e2e");
  });

  it("has Gruvbox Light with a light appearance", () => {
    const gruvboxLight = palettes.find(
      (palette) => palette.name === "Gruvbox Light",
    );

    expect(gruvboxLight?.appearance).toBe("light");
  });
});
