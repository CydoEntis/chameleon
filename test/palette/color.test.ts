import { describe, expect, it } from "vitest";
import { relativeLuminance } from "../../src/palette/color.js";

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
