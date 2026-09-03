import { describe, expect, it } from "vitest";
import { parseScheme } from "../../src/palette/scheme.js";

// Catppuccin Mocha, copied byte-for-byte from
// vendor/iterm2-color-schemes/windows-terminal/Catppuccin Mocha.json — a
// real scheme, not an invented fixture.
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

describe("parseScheme", () => {
  it("parses a real Windows Terminal scheme", () => {
    const scheme = parseScheme(catppuccinMocha);
    expect(scheme.name).toBe("Catppuccin Mocha");
    expect(scheme.background).toBe("#1e1e2e");
  });

  it("reports the missing slot by name when one is absent", () => {
    const withoutCursorColor: Record<string, unknown> = { ...catppuccinMocha };
    delete withoutCursorColor.cursorColor;

    expect(() => parseScheme(withoutCursorColor)).toThrowError(/cursorColor/);
  });

  it("rejects a slot that is not a 6-digit hex colour", () => {
    const malformed = { ...catppuccinMocha, background: "cornflowerblue" };

    expect(() => parseScheme(malformed)).toThrowError(/hex colour/);
  });

  it("rejects a scheme with no name", () => {
    const withoutName: Record<string, unknown> = { ...catppuccinMocha };
    delete withoutName.name;

    expect(() => parseScheme(withoutName)).toThrow();
  });
});
