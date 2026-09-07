import { describe, expect, it } from "vitest";
import { readPaperColorScheme, readTangoTangoScheme } from "../../tools/external-scheme-sources.js";
import { readVendoredScheme } from "../../tools/vendor-scheme-library.js";

/**
 * These read the two vendored non-JSON sources, so every expected value here
 * is that upstream's own authored colour — see each vendor directory's
 * SOURCE.txt for the pinned commit the values come from.
 */

describe("readPaperColorScheme", () => {
  it("decodes the dark profile to PaperColor.vim's own dark palette", () => {
    const paperColorDark = readPaperColorScheme("dark");

    expect(paperColorDark.name).toBe("PaperColor Dark");
    // color00 and color07 — the port maps background from one and text from
    // the other, which is what upstream means by those two slots.
    expect(paperColorDark.background).toBe("#1c1c1c");
    expect(paperColorDark.foreground).toBe("#d0d0d0");
    expect(paperColorDark.red).toBe("#af005f");
    expect(paperColorDark.yellow).toBe("#d7af5f");
  });

  it("prefers the authored NSComponents over Apple's lossy NSRGB conversion", () => {
    const paperColorDark = readPaperColorScheme("dark");

    // Both are archived for these two slots and they disagree: NSComponents
    // holds #1c1c1c / #af005f, which are PaperColor.vim's color00 / color01
    // exactly, where NSRGB holds #151515 / #b0004e. Reversing the preference
    // would ship colours upstream never authored, so it is pinned by a test
    // as well as by assertPortMatchesUpstreamPalette.
    expect(paperColorDark.background).not.toBe("#151515");
    expect(paperColorDark.red).not.toBe("#b0004e");
  });

  it("decodes the light profile, whose black slot is PaperColor's own background", () => {
    const paperColorLight = readPaperColorScheme("light");

    expect(paperColorLight.name).toBe("PaperColor Light");
    expect(paperColorLight.background).toBe("#eeeeee");
    expect(paperColorLight.foreground).toBe("#444444");

    // Upstream PaperColor's palette keys are syntax slots, not ANSI slots,
    // and this port carries that ordering through: color00 (#eeeeee, the
    // background) lands in ANSI black and color10 (#d70087, a pink) in
    // bright green. Asserted rather than corrected, because it is what the
    // vendored source says — repair happens downstream in ansi.ts, and
    // roles are assigned by measurement, never by slot name.
    expect(paperColorLight.black).toBe("#eeeeee");
    expect(paperColorLight.brightGreen).toBe("#d70087");
  });

  it("reproduces every one of upstream's 16 palette slots, in order", () => {
    // The build-time guard that licenses shipping a third-party port at all:
    // reaching here means assertPortMatchesUpstreamPalette compared all 16
    // slots of both variants against PaperColor.vim and found no difference.
    expect(() => readPaperColorScheme("dark")).not.toThrow();
    expect(() => readPaperColorScheme("light")).not.toThrow();
  });

  it("falls back to the text colour for the cursor, which the profile does not carry", () => {
    const paperColorDark = readPaperColorScheme("dark");

    expect(paperColorDark.cursorColor).toBe(paperColorDark.foreground);
  });

  it("seeds selection with the background, so the selection resolver derives one instead", () => {
    const paperColorLight = readPaperColorScheme("light");

    expect(paperColorLight.selectionBackground).toBe(paperColorLight.background);
  });
});

describe("readTangoTangoScheme", () => {
  it("takes the normal 8 from the theme's own term-color-* faces", () => {
    const tangoTango = readTangoTangoScheme();

    expect(tangoTango.red).toBe("#ef2929");
    expect(tangoTango.green).toBe("#6ac214");
    expect(tangoTango.yellow).toBe("#edd400");
    expect(tangoTango.white).toBe("#eeeeec");
  });

  it("resolves the X11 colour names term-color-* uses instead of hex", () => {
    const tangoTango = readTangoTangoScheme();

    expect(tangoTango.black).toBe("#000000");
    expect(tangoTango.blue).toBe("#1e90ff");
    expect(tangoTango.cyan).toBe("#e0ffff");
    expect(tangoTango.purple).toBe("#cd00cd");
  });

  it("takes the bright 8 from the Tango scheme, which authors no bright row of its own", () => {
    const tangoTango = readTangoTangoScheme();
    const tangoBright = readVendoredScheme("Builtin Tango Dark.json");

    expect(tangoTango.brightRed).toBe(tangoBright.brightRed);
    expect(tangoTango.brightGreen).toBe(tangoBright.brightGreen);
    expect(tangoTango.brightWhite).toBe(tangoBright.brightWhite);
  });

  it("re-grounds on the theme's own chrome, which is what makes it TangoTango and not Tango", () => {
    const tangoTango = readTangoTangoScheme();
    const tangoBright = readVendoredScheme("Builtin Tango Dark.json");

    expect(tangoTango.background).toBe("#2e3434");
    expect(tangoTango.foreground).toBe("#eeeeec");
    expect(tangoTango.cursorColor).toBe("#fce94f");
    expect(tangoTango.selectionBackground).toBe("#483d8b");

    expect(tangoTango.background).not.toBe(tangoBright.background);
  });

  it("keeps its own normal row rather than inheriting Tango's, which differs", () => {
    const tangoTango = readTangoTangoScheme();
    const tangoBright = readVendoredScheme("Builtin Tango Dark.json");

    // #6ac214 vs #4e9a06: the two palettes share a bright row but not a
    // normal one, which is why only the bright row is borrowed.
    expect(tangoTango.green).not.toBe(tangoBright.green);
  });
});
