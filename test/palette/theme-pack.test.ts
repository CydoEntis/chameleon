import { describe, expect, it } from "vitest";
import { ANSI_MIN_RATIO, MUTED_MIN_RATIO, ROLES, SELECTION_HUE_MIN_DISTANCE_DEGREES, SELECTION_MAX_CHROMA, SELECTION_MIN_RESOLVED_CHROMA, SELECTION_MIN_VISIBLE_RATIO, TEXT_MIN_RATIO } from "../../src/constants.js";
import { ANSI_SLOT_NAMES } from "../../src/palette/ansi.js";
import { chromaOf, contrastRatio, fromHsl, hueDistanceDegrees, toHsl } from "../../src/palette/color.js";
import { loadCuratedThemePacks } from "../../src/palette/theme-pack-library.js";
import { buildThemePack, parseThemePack, parseUserPackManifest } from "../../src/palette/theme-pack.js";
import { readVendoredScheme } from "../../tools/vendor-scheme-library.js";

/**
 * The only one of the 29 bundled packs whose own authored
 * `selectionBackground` already clears every one of resolveSelectionAndBody's
 * floors — contrast and chroma alike — untouched: chooseSelectionHue never
 * runs for it, so neither CHM-70's chroma nor its hue-distance guarantee
 * applies (verified against the pack's own raw vendored scheme, not asserted
 * from vibes). gruvbox-dark and monokai-dark used to sit in this set too
 * (CHM-38's and CHM-70's own named exceptions): both clear the two contrast
 * floors as authored, but at a chroma of 0.071 and 0.035 — grey-on-grey to
 * the eye. CHM-76 adds the chroma floor that catches them, so both are
 * retinted like any other repair now; jellybeans is the one pack left where
 * "clears the floors" and "carries real colour" already agreed.
 */
const PACKS_KEPT_AS_AUTHORED = new Set(["jellybeans"]);

const ATTRIBUTION = {
  source: "mbadolato/iTerm2-Color-Schemes",
  sourceUrl: "https://github.com/mbadolato/iTerm2-Color-Schemes",
  commit: "752a9c079396cc9939b86e893578ed81e80c140f",
  license: "MIT",
};

describe("buildThemePack", () => {
  it("carries the source scheme's identity and appearance into the manifest", () => {
    const scheme = readVendoredScheme("Dracula.json");
    const pack = buildThemePack(scheme, "Dracula", ATTRIBUTION);

    expect(pack.manifest.name).toBe("Dracula");
    expect(pack.manifest.family).toBe("Dracula");
    expect(pack.manifest.appearance).toBe("dark");
    expect(pack.manifest.slug).toBe("dracula-dark");
    expect(pack.manifest.attribution).toEqual(ATTRIBUTION);
  });

  it("ships the raw scheme as the windows-terminal payload, apart from a resolved selectionBackground and a repaired ANSI black", () => {
    const scheme = readVendoredScheme("Dracula.json");
    const pack = buildThemePack(scheme, "Dracula", ATTRIBUTION);

    const wtPayload = pack.payloads["windows-terminal"];
    // Every slot but selectionBackground and black passes through untouched.
    expect(wtPayload).toEqual({ ...scheme, black: wtPayload.black, selectionBackground: wtPayload.selectionBackground });
    // Dracula's own authored selectionBackground measures 1.56 for
    // selection-vs-ground — short of SELECTION_IDEAL_RATIO, and body clears
    // ground by 13.36, comfortably enough room to do better — so CHM-30
    // repairs it rather than shipping it unchanged.
    expect(wtPayload.selectionBackground).not.toBe(scheme.selectionBackground);
    // Dracula's own authored black measures 1.11 against ground — CHM-32's
    // own worked fixture — so it must be repaired rather than shipped
    // nearly invisible.
    expect(wtPayload.black).not.toBe(scheme.black);
    expect(contrastRatio(wtPayload.black, scheme.background)).toBeGreaterThanOrEqual(ANSI_MIN_RATIO);
  });

  it("resolves a role hex table for oh-my-posh and herdr, agreeing on ground, accent and success — herdr's own selection_bg is extra", () => {
    const scheme = readVendoredScheme("Dracula.json");
    const pack = buildThemePack(scheme, "Dracula", ATTRIBUTION);

    // body and muted are herdr-specific: both are eligible for a second
    // repair against the selected row's own background (CHM-50's
    // resolveActiveRowAndText), on top of CHM-30's selection-vs-body nudge to
    // body alone — Dracula's own body happens to already clear every floor
    // unrepaired, but muted does not. error is herdr-specific too (CHM-85):
    // Dracula's own error measures only 4.53 against ground, and moving
    // panel_bg away from ground at all — the fix this ticket exists for —
    // drops that below TEXT_MIN_RATIO, so herdr's own copy is repaired a
    // second time against panel_bg (see repairHerdrAccentFamily). accent and
    // success both keep enough headroom over ground for Dracula's own
    // panel_bg not to matter, so they still agree with oh-my-posh's copy —
    // see ThemePackPayloads' own doc comment for the general rule.
    for (const role of ["ground", "accent", "success"] as const) {
      expect(pack.payloads.herdr[role]).toBe(pack.payloads["oh-my-posh"][role]);
    }
    for (const role of ["muted", "error"] as const) {
      expect(pack.payloads.herdr[role]).not.toBe(pack.payloads["oh-my-posh"][role]);
    }
    expect(pack.payloads.herdr.selection_bg).toMatch(/^#[0-9a-f]{6}$/i);
    for (const role of ROLES) {
      expect(pack.payloads["oh-my-posh"][role]).toMatch(/^#[0-9a-f]{6}$/i);
      expect(pack.payloads.herdr[role]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("resolves a selection clearing body-on-selection for every bundled pack, and records the achieved selection-vs-ground so a regression is visible", () => {
    // Every bundled pack, generated by tools/build-theme-packs.ts and
    // committed under themes/ — the real 29, not a re-derived copy of the
    // curated table, so this proves what actually ships (CHM-30).
    const packs = loadCuratedThemePacks();
    expect(packs.length).toBeGreaterThan(0);

    for (const pack of packs) {
      const bodyHex = pack.payloads.herdr.body;
      const selectionHex = pack.payloads.herdr.selection_bg;
      const groundHex = pack.payloads.herdr.ground;

      // The hard floor: never traded away, on any of the 29 — see
      // palette/selection.ts's resolveSelectionAndBody.
      expect(contrastRatio(bodyHex, selectionHex)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
      // Recorded rather than hidden: every pack reaches at least a visible
      // highlight, even the 10 for which SELECTION_IDEAL_RATIO (2.0) is
      // mathematically unreachable alongside the hard floor above (see
      // CHM-30's own worked proof, e.g. tokyo-night-light's 4.52).
      expect(contrastRatio(selectionHex, groundHex)).toBeGreaterThanOrEqual(SELECTION_MIN_VISIBLE_RATIO);
    }
  });

  it("clears SELECTION_MIN_RESOLVED_CHROMA for every bundled pack's resolved selection, whether or not a repair fired (CHM-76)", () => {
    // Unlike the chroma test below, this loop is *not* filtered by
    // PACKS_KEPT_AS_AUTHORED — that is the whole point. Before CHM-76,
    // gruvbox-dark and monokai-dark shipped their own authored
    // selectionBackground untouched (chroma 0.071 and 0.035) because
    // CHM-70's tint only ran once a contrast repair had already fired; this
    // asserts the floor now holds on every one of the 29, including the one
    // pack (jellybeans) still kept exactly as authored.
    const packs = loadCuratedThemePacks();
    expect(packs.length).toBeGreaterThan(0);

    for (const pack of packs) {
      expect(chromaOf(pack.payloads.herdr.selection_bg), pack.manifest.slug).toBeGreaterThanOrEqual(SELECTION_MIN_RESOLVED_CHROMA);
    }
  });

  // The two packs this ticket names by hand: both clear resolveSelectionAndBody's
  // two contrast floors as authored, yet both shipped a highlight
  // indistinguishable by eye from their own background before this fix.
  const CHROMA_FLOOR_FIXTURES = [
    { slug: "monokai-dark", authoredChroma: 0.035, resolvedChroma: 0.584 },
    { slug: "gruvbox-dark", authoredChroma: 0.071, resolvedChroma: 0.424 },
  ];

  it.each(CHROMA_FLOOR_FIXTURES)(
    "retints $slug's selection past SELECTION_MIN_RESOLVED_CHROMA, up from its authored $authoredChroma (CHM-76)",
    ({ slug, authoredChroma, resolvedChroma }) => {
      const packs = loadCuratedThemePacks();
      const pack = packs.find((candidate) => candidate.manifest.slug === slug);
      if (!pack) throw new Error(`fixture pack not found: ${slug}`);

      const { ground: groundHex, body: bodyHex, selection_bg: selectionHex } = pack.payloads.herdr;
      expect(authoredChroma).toBeLessThan(SELECTION_MIN_RESOLVED_CHROMA);
      expect(chromaOf(selectionHex)).toBeCloseTo(resolvedChroma, 2);
      expect(chromaOf(selectionHex)).toBeGreaterThanOrEqual(SELECTION_MIN_RESOLVED_CHROMA);
      // Still clears CHM-30's own two floors — this fix adds a third,
      // never trades either of the first two away for it.
      expect(contrastRatio(selectionHex, groundHex)).toBeGreaterThanOrEqual(SELECTION_MIN_VISIBLE_RATIO);
      expect(contrastRatio(bodyHex, selectionHex)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
    },
  );

  it("gives every repaired pack a selection with chroma well above CHM-38's old clamp, not just a hue-free grey (CHM-38, raised by CHM-70)", () => {
    // The real 29 committed under themes/, minus the one exception whose own
    // authored candidate was kept untouched — see PACKS_KEPT_AS_AUTHORED.
    const packs = loadCuratedThemePacks().filter((pack) => !PACKS_KEPT_AS_AUTHORED.has(pack.manifest.slug));
    expect(packs.length).toBe(28);

    for (const pack of packs) {
      expect(chromaOf(pack.payloads.herdr.selection_bg), pack.manifest.slug).toBeGreaterThan(SELECTION_MAX_CHROMA);
    }
  });

  it("keeps a repaired selection's hue distinct from ground's own by at least SELECTION_HUE_MIN_DISTANCE_DEGREES, whenever it used accent's own hue rather than the fallback (CHM-70)", () => {
    // Same 28, same exemption as the chroma test above. A shipped selection
    // hue within a degree of accent's own means chooseSelectionHue used
    // accent directly (see hueTintedAtLuminance, which preserves hue exactly
    // — only luminance and chroma move); anything else means the fallback to
    // success/error fired, which this ticket only requires to be *reported*,
    // not to itself clear the same distance.
    const HUE_ROUNDING_TOLERANCE_DEGREES = 1;
    const packs = loadCuratedThemePacks().filter((pack) => !PACKS_KEPT_AS_AUTHORED.has(pack.manifest.slug));
    expect(packs.length).toBe(28);

    for (const pack of packs) {
      const groundHue = toHsl(pack.payloads.herdr.ground).hue;
      const accentHue = toHsl(pack.payloads.herdr.accent).hue;
      const selectionHue = toHsl(pack.payloads.herdr.selection_bg).hue;
      const usedAccentHueDirectly = hueDistanceDegrees(selectionHue, accentHue) < HUE_ROUNDING_TOLERANCE_DEGREES;

      if (usedAccentHueDirectly) {
        // kanagawa-dark's own accent sits exactly 20.0° from ground, but the
        // *shipped* selection hex — a different chroma and lightness than
        // accent's own, rounded to its nearest 8-bit RGB triple — measures a
        // hair under that (19.91°) purely from where that rounding lands;
        // the same HUE_ROUNDING_TOLERANCE_DEGREES chooseSelectionHue's own
        // 8-bit output is never exempt from elsewhere in this file.
        expect(hueDistanceDegrees(selectionHue, groundHue), pack.manifest.slug).toBeGreaterThan(
          SELECTION_HUE_MIN_DISTANCE_DEGREES - HUE_ROUNDING_TOLERANCE_DEGREES,
        );
      }
    }
  });

  // The three packs this ticket names by hand: dark, desaturated grounds,
  // where a merely-lighter-shade-of-grey selection is least visible against
  // its own background — nord-dark and catppuccin-dark use accent's own hue
  // directly, one-half-dark's accent (13.0° from ground) is too close to use
  // and demonstrates the fallback to error's hue (135.4° from ground)
  // instead. Achieved numbers are this fix's own output, not invented,
  // confirmed against each pack's own raw vendored scheme (accent's hue is
  // untouched by repair — see roles.ts's assignRolesByContrast).
  const HUE_AND_CHROMA_FIXTURES = [
    { slug: "nord-dark", chroma: 0.522, hueDistance: 26.5, usedFallbackHue: false },
    { slug: "catppuccin-dark", chroma: 0.4, hueDistance: 70, usedFallbackHue: false },
    { slug: "one-half-dark", chroma: 0.761, hueDistance: 135.4, usedFallbackHue: true },
  ];

  it.each(HUE_AND_CHROMA_FIXTURES)(
    "resolves $slug's selection with the named chroma and hue distance from ground (fallback fired: $usedFallbackHue)",
    ({ slug, chroma, hueDistance, usedFallbackHue }) => {
      const packs = loadCuratedThemePacks();
      const pack = packs.find((candidate) => candidate.manifest.slug === slug);
      if (!pack) throw new Error(`fixture pack not found: ${slug}`);

      const { ground: groundHex, body: bodyHex, accent: accentHex, selection_bg: selectionHex } = pack.payloads.herdr;
      const groundHue = toHsl(groundHex).hue;
      const selectionHue = toHsl(selectionHex).hue;
      const accentHue = toHsl(accentHex).hue;
      const usedAccentHueDirectly = hueDistanceDegrees(selectionHue, accentHue) < 1;

      expect(usedAccentHueDirectly).toBe(!usedFallbackHue);
      expect(chromaOf(selectionHex)).toBeCloseTo(chroma, 2);
      expect(hueDistanceDegrees(selectionHue, groundHue)).toBeCloseTo(hueDistance, 0);
      // Still clears CHM-50's own floors — this fix changes hue and chroma,
      // never the two contrast guarantees CHM-30/CHM-50 already established.
      expect(contrastRatio(selectionHex, groundHex)).toBeGreaterThanOrEqual(SELECTION_MIN_VISIBLE_RATIO);
      expect(contrastRatio(bodyHex, selectionHex)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
    },
  );

  it("never ships a pure black or pure white selection (CHM-38 fixture: Solarized Dark shipped #000000)", () => {
    const packs = loadCuratedThemePacks();
    expect(packs.length).toBeGreaterThan(0);

    for (const pack of packs) {
      expect(pack.payloads.herdr.selection_bg).not.toBe("#000000");
      expect(pack.payloads.herdr.selection_bg).not.toBe("#ffffff");
    }
  });

  it("repairs Solarized Dark's muted, which fails its floor before repair (fixture: 2.11)", () => {
    const scheme = readVendoredScheme("iTerm2 Solarized Dark.json");
    const pack = buildThemePack(scheme, "Solarized", ATTRIBUTION);

    const groundHex = pack.payloads["oh-my-posh"].ground;
    const mutedHex = pack.payloads["oh-my-posh"].muted;
    expect(contrastRatio(mutedHex, groundHex)).toBeGreaterThanOrEqual(MUTED_MIN_RATIO);
  });

  it("clears every text role's floor for every curated family — Gruvbox Dark's accent fails before repair (fixture: 3.48)", () => {
    const scheme = readVendoredScheme("Gruvbox Dark.json");
    const pack = buildThemePack(scheme, "Gruvbox", ATTRIBUTION);

    const groundHex = pack.payloads["oh-my-posh"].ground;
    for (const role of ["body", "accent", "success", "error"] as const) {
      const hex = pack.payloads["oh-my-posh"][role];
      expect(contrastRatio(hex, groundHex)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
    }
  });

  // CHM-89: the statusline's context, 5-hour and 7-day meters all rendered
  // in muted, so a line whose visual weight is three meters showed one
  // colour across the bulk of it. These three checks are the acceptance
  // criteria stated directly against the pack, not just against
  // buildStatuslineText's own formatting — every one of the 29 bundled
  // packs, not a hand-picked few, since a single failing pack reproduces
  // the reported bug for whoever has it active.
  it("gives every bundled pack three statusline meter colours that clear TEXT_MIN_RATIO against ground, for every one of the 29", () => {
    const packs = loadCuratedThemePacks();
    expect(packs.length).toBeGreaterThan(0);

    for (const pack of packs) {
      const groundHex = pack.payloads["oh-my-posh"].ground;
      const { context, fiveHour, sevenDay } = pack.payloads.statusline;
      for (const hex of [context, fiveHour, sevenDay]) {
        expect(contrastRatio(hex, groundHex), pack.manifest.slug).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
      }
    }
  });

  it("never gives a bundled pack a statusline meter equal to its own muted — the CHM-89 bug was all three meters rendering in muted", () => {
    const packs = loadCuratedThemePacks();
    expect(packs.length).toBeGreaterThan(0);

    for (const pack of packs) {
      const mutedHex = pack.payloads["oh-my-posh"].muted;
      const { context, fiveHour, sevenDay } = pack.payloads.statusline;
      expect([context, fiveHour, sevenDay], pack.manifest.slug).not.toContain(mutedHex);
    }
  });

  it("gives every bundled pack three statusline meter colours that all differ from one another", () => {
    const packs = loadCuratedThemePacks();
    expect(packs.length).toBeGreaterThan(0);

    for (const pack of packs) {
      const { context, fiveHour, sevenDay } = pack.payloads.statusline;
      expect(new Set([context, fiveHour, sevenDay]).size, pack.manifest.slug).toBe(3);
    }
  });

  it("omits attribution entirely when none is given — a user pack has no upstream to credit", () => {
    const scheme = readVendoredScheme("Dracula.json");
    const pack = buildThemePack(scheme, "Dracula");

    expect(pack.manifest.attribution).toBeUndefined();
    expect(Object.hasOwn(pack.manifest, "attribution")).toBe(false);
  });

  it("uses an explicit slug verbatim instead of deriving one from family and appearance", () => {
    const scheme = readVendoredScheme("Dracula.json");
    const pack = buildThemePack(scheme, "Dracula", undefined, "catppuccin-dark");

    // "catppuccin-dark" is not what toSlug("Dracula", "dark") would produce
    // ("dracula-dark") — proving the explicit slug wins outright, not just
    // as a tiebreak.
    expect(pack.manifest.slug).toBe("catppuccin-dark");
  });

  it("still derives a slug from family and appearance when no explicit slug is given", () => {
    const scheme = readVendoredScheme("Dracula.json");
    const pack = buildThemePack(scheme, "Dracula", ATTRIBUTION);

    expect(pack.manifest.slug).toBe("dracula-dark");
  });
});

describe("Windows Terminal's own foreground clears body-on-selection (CHM-33)", () => {
  // CHM-33: three bundled packs shipped Windows Terminal's own raw,
  // unrepaired `foreground` sitting behind the *resolved* `selectionBackground`
  // — unreadable underneath it (3.13/3.60/3.48 for body-on-selection, floor
  // 4.5) even though herdr's own copy of body, already nudged by
  // resolveSelectionAndBody, was fine all along. buildThemePack now wires
  // that same resolved body into this payload's `foreground` too, so the two
  // targets can never disagree about what body is, the same way they already
  // could not disagree about what selection is (CHM-30).
  it("clears body-on-selection for every one of the 29 bundled packs, measured the way the terminal itself paints it — foreground on selectionBackground", () => {
    const packs = loadCuratedThemePacks();
    expect(packs.length).toBe(29);

    for (const pack of packs) {
      const { foreground, selectionBackground } = pack.payloads["windows-terminal"];
      expect(contrastRatio(foreground, selectionBackground)).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
    }
  });

  // The three packs this ticket names by hand, asserted individually rather
  // than folded into the loop above, so a regression on any one of them
  // fails with its own slug and achieved ratio rather than a generic
  // "some pack failed" message. Achieved ratios are this fix's own output
  // (see tools/build-theme-packs.ts's describeBodyNudge), not invented.
  // tokyo-night-light's own ratio moved slightly (4.70 -> 4.76) under
  // CHM-70: `foreground` is unchanged, but `selectionBackground` now carries
  // real chroma instead of a hue-free grey, and an RGB triple rounds to its
  // nearest 8-bit byte slightly differently than a single repeated grey
  // byte does at the same target luminance — see selection.ts's own doc
  // comment on maxChromaClearingFloors.
  const NAMED_FIXTURES = [
    { slug: "solarized-light", achievedRatio: 4.73 },
    { slug: "everforest-light", achievedRatio: 4.75 },
    { slug: "tokyo-night-light", achievedRatio: 4.76 },
  ];

  it.each(NAMED_FIXTURES)(
    "clears body-on-selection for $slug, one of the three CHM-33 names by hand (fixture: shipped 3.13/3.60/3.48 before this fix)",
    ({ slug, achievedRatio }) => {
      const packs = loadCuratedThemePacks();
      const pack = packs.find((candidate) => candidate.manifest.slug === slug);
      if (!pack) throw new Error(`fixture pack not found: ${slug}`);

      const { foreground, selectionBackground } = pack.payloads["windows-terminal"];
      const ratio = contrastRatio(foreground, selectionBackground);
      expect(ratio).toBeGreaterThanOrEqual(TEXT_MIN_RATIO);
      expect(ratio).toBeCloseTo(achievedRatio, 1);
    },
  );

  /**
   * Every selection-vs-ground ratio a hue-free grey can reach while also
   * clearing `bodyFloorRatio` against `bodyHex`, sampled finely across the
   * whole luminance range rather than reasoned about analytically — a
   * brute-force check independent of selection.ts's own search, so this
   * proves the feasible band's shape instead of assuming the code under
   * test got it right (code-standards.md, "test behavior, not
   * implementation"). Restricting to grey is not a narrowing of the search:
   * contrastRatio is a function of luminance alone, so a tinted colour at
   * the same luminance reaches the exact same ratio (see
   * groundTintedAtLuminance's own doc comment).
   */
  function bestGroundRatioClearingBodyFloor(groundHex: string, bodyHex: string, bodyFloorRatio: number): number {
    const SAMPLE_COUNT = 2000;
    let best = 1;
    for (let sample = 0; sample <= SAMPLE_COUNT; sample += 1) {
      const candidateHex = fromHsl({ hue: 0, saturation: 0, lightness: (sample / SAMPLE_COUNT) * 100 });
      if (contrastRatio(candidateHex, bodyHex) < bodyFloorRatio) continue;
      best = Math.max(best, contrastRatio(candidateHex, groundHex));
    }
    return best;
  }

  it("computes everforest-light's feasible band against its own unrepaired body and shows it is empty at SELECTION_MIN_VISIBLE_RATIO — the one pack CHM-33 calls genuinely infeasible, not merely buggy", () => {
    // everforest-light's own raw scheme values (ground, foreground) — see
    // themes/everforest-light.json's history, before CHM-33's body nudge.
    const best = bestGroundRatioClearingBodyFloor("#efebd4", "#5c6a72", TEXT_MIN_RATIO);

    expect(best).toBeLessThan(SELECTION_MIN_VISIBLE_RATIO);
    expect(best).toBeCloseTo(1.2, 1);
  });

  it("computes solarized-light and tokyo-night-light as feasible against their own unrepaired body — ordinary bugs, not impossibilities, unlike everforest-light above", () => {
    // Both packs' own raw scheme values (ground, foreground).
    const solarizedBest = bestGroundRatioClearingBodyFloor("#fdf6e3", "#657b83", TEXT_MIN_RATIO);
    const tokyoNightBest = bestGroundRatioClearingBodyFloor("#e1e2e7", "#3760bf", TEXT_MIN_RATIO);

    expect(solarizedBest).toBeGreaterThanOrEqual(SELECTION_MIN_VISIBLE_RATIO);
    expect(tokyoNightBest).toBeGreaterThanOrEqual(SELECTION_MIN_VISIBLE_RATIO);
  });
});

describe("ANSI slot repair (CHM-32)", () => {
  it("clears ANSI_MIN_RATIO for every one of the 16 ANSI slots, in every bundled pack", () => {
    // The real 29 committed under themes/, generated by
    // tools/build-theme-packs.ts — not a re-derived copy — so this proves
    // what actually ships.
    const packs = loadCuratedThemePacks();
    expect(packs.length).toBeGreaterThan(0);

    for (const pack of packs) {
      const scheme = pack.payloads["windows-terminal"];
      for (const slotName of ANSI_SLOT_NAMES) {
        expect(contrastRatio(scheme[slotName], scheme.background)).toBeGreaterThanOrEqual(ANSI_MIN_RATIO);
      }
    }
  });

  // The four bundled packs CHM-32 names by hand: ANSI black shipped
  // byte-identical to the background (contrast 1.00) before this repair —
  // the "black circles in dark mode" bug, Claude Code's own bullet markers
  // drawn in ANSI black.
  const BLACK_AT_ONE_FIXTURES = [
    { slug: "gruvbox-dark", fileName: "Gruvbox Dark.json" },
    { slug: "gruvbox-light", fileName: "Gruvbox Light.json" },
    { slug: "monokai-dark", fileName: "Monokai Classic.json" },
    { slug: "night-owl-dark", fileName: "Night Owl.json" },
  ];

  it.each(BLACK_AT_ONE_FIXTURES)("repairs $slug's ANSI black, shipped byte-identical to its background before CHM-32 (fixture: 1.00)", ({ slug, fileName }) => {
    const originalScheme = readVendoredScheme(fileName);
    expect(contrastRatio(originalScheme.black, originalScheme.background)).toBeCloseTo(1, 2);

    const packs = loadCuratedThemePacks();
    const pack = packs.find((candidate) => candidate.manifest.slug === slug);
    if (!pack) throw new Error(`fixture pack not found: ${slug}`);

    const shippedBlack = pack.payloads["windows-terminal"].black;
    expect(shippedBlack).not.toBe(originalScheme.black);
    expect(contrastRatio(shippedBlack, pack.payloads["windows-terminal"].background)).toBeGreaterThanOrEqual(ANSI_MIN_RATIO);
  });
});

describe("parseThemePack", () => {
  it("round-trips a built pack through JSON", () => {
    const scheme = readVendoredScheme("Dracula.json");
    const pack = buildThemePack(scheme, "Dracula", ATTRIBUTION);

    const roundTripped = parseThemePack(JSON.parse(JSON.stringify(pack)), "dracula-dark.json");
    expect(roundTripped).toEqual(pack);
  });

  it("names the file when a pack is malformed", () => {
    expect(() => parseThemePack({ manifest: {} }, "broken.json")).toThrow(/broken\.json/);
  });
});

describe("parseUserPackManifest", () => {
  it("parses a user manifest naming a scheme, a family and a declared slug", () => {
    const scheme = readVendoredScheme("Dracula.json");
    const manifest = parseUserPackManifest({ slug: "my-dracula-dark", family: "My Dracula", scheme }, "my-dracula");

    expect(manifest.slug).toBe("my-dracula-dark");
    expect(manifest.family).toBe("My Dracula");
    expect(manifest.scheme).toEqual(scheme);
  });

  it("allows slug and family to both be omitted", () => {
    const scheme = readVendoredScheme("Dracula.json");
    const manifest = parseUserPackManifest({ scheme }, "my-dracula");

    expect(manifest.slug).toBeUndefined();
    expect(manifest.family).toBeUndefined();
  });

  it("names the pack directory when a user manifest is malformed", () => {
    expect(() => parseUserPackManifest({ family: "Broken" }, "broken-pack")).toThrow(/broken-pack/);
  });
});
