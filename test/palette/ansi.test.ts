import { describe, expect, it } from "vitest";
import { ANSI_MIN_RATIO } from "../../src/constants.js";
import { ANSI_SLOT_NAMES, repairAnsiSlots } from "../../src/palette/ansi.js";
import { contrastRatio, toHsl } from "../../src/palette/color.js";
import { readVendoredScheme } from "../../tools/vendor-scheme-library.js";

// Real vendored schemes' real values only — see code-standards.md, "Colour
// tests use real schemes' real values".

/** The hue tolerance a repaired colour must stay within of its pre-repair hue — matches repair.test.ts's own HUE_TOLERANCE_DEGREES. */
const HUE_TOLERANCE_DEGREES = 3;

describe("repairAnsiSlots", () => {
  it("leaves every slot untouched when all 16 already clear the floor", () => {
    // GitHub Dark's own 16 ANSI slots all clear ANSI_MIN_RATIO as authored.
    const scheme = readVendoredScheme("GitHub Dark Default.json");
    const report = repairAnsiSlots(scheme);

    expect(report.repairedSlots).toEqual([]);
    for (const slotName of ANSI_SLOT_NAMES) {
      expect(report.slots[slotName]).toBe(scheme[slotName]);
    }
  });

  it("repairs Ayu Mirage's black, which fails the floor before repair (fixture: 1.11)", () => {
    const scheme = readVendoredScheme("Ayu Mirage.json");
    expect(contrastRatio(scheme.black, scheme.background)).toBeCloseTo(1.11, 2);

    const report = repairAnsiSlots(scheme);
    expect(report.repairedSlots).toContain("black");
    expect(report.slots.black).not.toBe(scheme.black);
    expect(contrastRatio(report.slots.black, scheme.background)).toBeGreaterThanOrEqual(ANSI_MIN_RATIO);
  });

  it.each([
    { fileName: "Gruvbox Dark.json", family: "Gruvbox Dark" },
    { fileName: "Gruvbox Light.json", family: "Gruvbox Light" },
    { fileName: "Monokai Classic.json", family: "Monokai" },
    { fileName: "Night Owl.json", family: "Night Owl" },
  ])("repairs $family's ANSI black, byte-identical to its own background before repair (fixture: 1.00)", ({ fileName }) => {
    const scheme = readVendoredScheme(fileName);
    expect(contrastRatio(scheme.black, scheme.background)).toBeCloseTo(1, 2);

    const report = repairAnsiSlots(scheme);
    expect(report.repairedSlots).toContain("black");
    expect(contrastRatio(report.slots.black, scheme.background)).toBeGreaterThanOrEqual(ANSI_MIN_RATIO);
  });

  it("repairs only the slots below the floor, leaving the rest byte-identical (Ayu Light: yellow, white, brightYellow, brightWhite)", () => {
    const scheme = readVendoredScheme("Ayu Light.json");
    const report = repairAnsiSlots(scheme);

    const expectedRepaired = ["yellow", "white", "brightYellow", "brightWhite"];
    expect([...report.repairedSlots].sort()).toEqual([...expectedRepaired].sort());

    for (const slotName of ANSI_SLOT_NAMES) {
      if (expectedRepaired.includes(slotName)) continue;
      expect(report.slots[slotName]).toBe(scheme[slotName]);
    }
  });

  it("preserves Night Owlish Light's repaired brightYellow hue within tolerance (fixture: 1.76)", () => {
    const scheme = readVendoredScheme("Night Owlish Light.json");
    expect(contrastRatio(scheme.brightYellow, scheme.background)).toBeCloseTo(1.76, 2);

    const report = repairAnsiSlots(scheme);
    expect(report.repairedSlots).toContain("brightYellow");

    const hueBefore = toHsl(scheme.brightYellow).hue;
    const hueAfter = toHsl(report.slots.brightYellow).hue;
    expect(Math.abs(hueBefore - hueAfter)).toBeLessThanOrEqual(HUE_TOLERANCE_DEGREES);
  });

  it("clears the floor for every one of the 16 slots across every curated scheme", () => {
    const fileNames = [
      "GitHub Dark Default.json",
      "GitHub Light Default.json",
      "One Half Dark.json",
      "One Half Light.json",
      "Ayu Mirage.json",
      "Ayu Light.json",
      "Night Owl.json",
      "Night Owlish Light.json",
      "TokyoNight Night.json",
      "TokyoNight Day.json",
      "Catppuccin Mocha.json",
      "Catppuccin Latte.json",
      "Nord.json",
      "Nord Light.json",
      "Gruvbox Dark.json",
      "Gruvbox Light.json",
      "Rose Pine.json",
      "Rose Pine Dawn.json",
      "iTerm2 Solarized Dark.json",
      "iTerm2 Solarized Light.json",
      "Kanagawa Wave.json",
      "Kanagawa Lotus.json",
      "Everforest Dark Med.json",
      "Everforest Light Med.json",
      "Dracula.json",
      "Monokai Classic.json",
    ];

    for (const fileName of fileNames) {
      const scheme = readVendoredScheme(fileName);
      const report = repairAnsiSlots(scheme);
      for (const slotName of ANSI_SLOT_NAMES) {
        expect(contrastRatio(report.slots[slotName], scheme.background)).toBeGreaterThanOrEqual(ANSI_MIN_RATIO);
      }
    }
  });
});
