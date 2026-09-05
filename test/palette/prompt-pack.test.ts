import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TEXT_MIN_RATIO, type Role } from "../../src/constants.js";
import { contrastRatio } from "../../src/palette/color.js";
import {
  assertPromptLayoutIsSafe,
  countSegments,
  findContrastFailures,
  findGroundPairingViolations,
  findLiteralHexColors,
  findNerdFontGlyphs,
  lintPromptLayout,
  parsePromptLayout,
} from "../../src/palette/prompt-pack.js";

/** A minimal, valid layout: one segment with a foreground role and no background (renders on the terminal's own background, i.e. ground) — the GOOD "no background" shape from CLAUDE.md's authoring rule. */
const SAFE_LAYOUT_TEXT = JSON.stringify({
  blocks: [{ segments: [{ foreground: "p:accent", template: "safe" }] }],
});

/** The GOOD "chip" shape: background p:accent, foreground p:ground. */
const SAFE_CHIP_LAYOUT_TEXT = JSON.stringify({
  blocks: [{ segments: [{ foreground: "p:ground", background: "p:accent", template: "chip" }] }],
});

const BROKEN_FIXTURE_PATH = path.join(__dirname, "fixtures", "broken-prompt-layout.omp.json");

describe("parsePromptLayout", () => {
  it("parses a minimal valid layout", () => {
    const layout = parsePromptLayout(JSON.parse(SAFE_LAYOUT_TEXT), "safe.omp.json");
    expect(layout.blocks).toHaveLength(1);
  });

  it("names the file when the shape is wrong, rather than throwing a bare ZodError", () => {
    expect(() => parsePromptLayout({ blocks: "not an array" }, "broken.omp.json")).toThrow(/broken\.omp\.json/);
  });
});

describe("findLiteralHexColors", () => {
  it("finds nothing in a layout built entirely from role references", () => {
    expect(findLiteralHexColors(SAFE_LAYOUT_TEXT)).toEqual([]);
  });

  it("finds a literal hex colour anywhere in the raw text, deduplicated", () => {
    const text = JSON.stringify({ blocks: [{ segments: [{ foreground: "#ff00aa" }, { background: "#ff00aa" }] }] });
    expect(findLiteralHexColors(text)).toEqual(["#ff00aa"]);
  });
});

describe("findGroundPairingViolations", () => {
  it("passes a segment with only a foreground and no background", () => {
    const layout = parsePromptLayout(JSON.parse(SAFE_LAYOUT_TEXT), "safe.omp.json");
    expect(findGroundPairingViolations(layout)).toEqual([]);
  });

  it("passes a chip segment — background is a colour, foreground is ground", () => {
    const layout = parsePromptLayout(JSON.parse(SAFE_CHIP_LAYOUT_TEXT), "chip.omp.json");
    expect(findGroundPairingViolations(layout)).toEqual([]);
  });

  it("rejects a segment whose foreground and background are both non-ground roles — CLAUDE.md's BAD example, body on accent", () => {
    const text = JSON.stringify({ blocks: [{ segments: [{ foreground: "p:body", background: "p:accent" }] }] });
    const layout = parsePromptLayout(JSON.parse(text), "bad.omp.json");
    const violations = findGroundPairingViolations(layout);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/neither is ground/);
  });

  it("rejects a foreground that is not a p:<role> reference at all", () => {
    const text = JSON.stringify({ blocks: [{ segments: [{ foreground: "red" }] }] });
    const layout = parsePromptLayout(JSON.parse(text), "bad.omp.json");
    const violations = findGroundPairingViolations(layout);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/not a "p:<role>" reference/);
  });
});

describe("lintPromptLayout and assertPromptLayoutIsSafe — proving the lint actually catches a hand-broken fixture", () => {
  it("reports zero violations for a layout built entirely from role references", () => {
    expect(lintPromptLayout(SAFE_LAYOUT_TEXT, "safe.omp.json")).toEqual([]);
    expect(() => assertPromptLayoutIsSafe(SAFE_LAYOUT_TEXT, "safe.omp.json")).not.toThrow();
  });

  it("catches a hand-broken fixture carrying both defects: a literal hex colour and a non-ground-paired segment", () => {
    const brokenText = readFileSync(BROKEN_FIXTURE_PATH, "utf8");
    const violations = lintPromptLayout(brokenText, "broken-prompt-layout.omp.json");

    // Both defects are reported, not just whichever one the lint happens to
    // find first — a lint that stops at its first violation would let the
    // other one ship unnoticed.
    expect(violations.some((violation) => violation.includes("#ff0000"))).toBe(true);
    expect(violations.some((violation) => violation.includes("neither is ground"))).toBe(true);
  });

  it("throws, naming the file, when assertPromptLayoutIsSafe is run against the broken fixture — the build-time gate itself, not just the pure check it is built on", () => {
    const brokenText = readFileSync(BROKEN_FIXTURE_PATH, "utf8");
    expect(() => assertPromptLayoutIsSafe(brokenText, "broken-prompt-layout.omp.json")).toThrow(/broken-prompt-layout\.omp\.json/);
  });
});

describe("findNerdFontGlyphs", () => {
  it("finds nothing in a layout with no Nerd Font glyphs at all", () => {
    expect(findNerdFontGlyphs(SAFE_LAYOUT_TEXT)).toEqual([]);
  });

  it("finds a Nerd Font Private Use Area codepoint", () => {
    const text = JSON.stringify({ blocks: [{ segments: [{ template: " done" }] }] });
    expect(findNerdFontGlyphs(text)).toEqual([""]);
  });

  it("does not mistake ordinary Go-template punctuation for a glyph", () => {
    const text = JSON.stringify({ blocks: [{ segments: [{ template: "{{ .Path }}{{ if .Working.Changed }}*{{ end }}" }] }] });
    expect(findNerdFontGlyphs(text)).toEqual([]);
  });
});

describe("countSegments", () => {
  it("counts every segment across every block", () => {
    const text = JSON.stringify({
      blocks: [{ segments: [{ foreground: "p:accent" }, { foreground: "p:body" }] }, { segments: [{ foreground: "p:muted" }] }],
    });
    const layout = parsePromptLayout(JSON.parse(text), "layout.omp.json");
    expect(countSegments(layout)).toBe(3);
  });

  it("counts zero for a layout with no segments, rather than skipping the assertion — CHM-40's own failure mode was a check that silently ran against nothing", () => {
    const layout = parsePromptLayout(JSON.parse(JSON.stringify({ blocks: [] })), "empty.omp.json");
    expect(countSegments(layout)).toBe(0);
  });
});

describe("findContrastFailures", () => {
  // Real, measured values from Solarized Dark's own resolved role table
  // (themes/solarized-dark.json) — the pack CLAUDE.md names as the one
  // where body and accent measure 1.00 against each other. Colour tests use
  // real schemes' real values, never invented hex (code-standards.md).
  const SOLARIZED_DARK_ROLE_HEXES: Readonly<Record<Role, string>> = {
    ground: "#002b36",
    body: "#93a1a1",
    accent: "#93a1a1",
    muted: "#586e75",
    success: "#b58900",
    error: "#dc322f",
  };

  it("passes a segment whose foreground clears TEXT_MIN_RATIO against ground", () => {
    const layout = parsePromptLayout(JSON.parse(SAFE_LAYOUT_TEXT), "safe.omp.json");
    expect(findContrastFailures(layout, SOLARIZED_DARK_ROLE_HEXES, "solarized-dark")).toEqual([]);
  });

  it("fails a chip whose foreground and background are the same colour on this pack — Solarized Dark's own body/accent collision", () => {
    // A chip is normally ground-paired (background p:accent, foreground
    // p:ground) and therefore safe on every pack — this segment is
    // deliberately built the unsafe way, foreground p:accent on background
    // p:body, to prove findContrastFailures measures the real pack colours
    // rather than trusting the authoring rule alone.
    const text = JSON.stringify({ blocks: [{ segments: [{ foreground: "p:accent", background: "p:body" }] }] });
    const layout = parsePromptLayout(JSON.parse(text), "unsafe.omp.json");

    const failures = findContrastFailures(layout, SOLARIZED_DARK_ROLE_HEXES, "solarized-dark");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("solarized-dark");
  });

  it("measures the floor as exactly TEXT_MIN_RATIO — a pack whose ratio sits just under it fails, just at or over it passes", () => {
    const layout = parsePromptLayout(JSON.parse(SAFE_LAYOUT_TEXT), "safe.omp.json");
    // ground vs body chosen so contrastRatio lands just under, then just
    // over, TEXT_MIN_RATIO — proving findContrastFailures' own floor is
    // this constant, not a looser or stricter one it happens to agree with
    // by coincidence on the fixtures above.
    const justUnderFloor: Readonly<Record<Role, string>> = { ...SOLARIZED_DARK_ROLE_HEXES, accent: "#8a8a8a" };
    const justOverFloor: Readonly<Record<Role, string>> = { ...SOLARIZED_DARK_ROLE_HEXES, accent: "#909090" };
    expect(contrastRatio(justUnderFloor.accent, justUnderFloor.ground)).toBeLessThan(TEXT_MIN_RATIO);
    expect(contrastRatio(justOverFloor.accent, justOverFloor.ground)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);

    expect(findContrastFailures(layout, justUnderFloor, "fixture")).toHaveLength(1);
    expect(findContrastFailures(layout, justOverFloor, "fixture")).toHaveLength(0);
  });
});
