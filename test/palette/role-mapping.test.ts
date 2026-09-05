import { describe, expect, it } from "vitest";
import { contrastRatio } from "../../src/palette/color.js";
import { recoloredHexFor } from "../../src/palette/role-mapping.js";
import { resolveRoleHexes } from "../../src/palette/repair.js";
import { parseScheme, type Scheme } from "../../src/palette/scheme.js";
import { loadCuratedThemePacks } from "../../src/palette/theme-pack-library.js";

// Real vendored scheme values (mbadolato/iTerm2-Color-Schemes), never
// invented hex — see vendor/iterm2-color-schemes/windows-terminal/. Used to
// resolve a real set of role hexes for recoloredHexFor to retint against,
// the same way the real oh-my-posh adapter does.
const ZEROX96F_SCHEME: Scheme = parseScheme({
  name: "0x96f",
  black: "#262427",
  red: "#ff666d",
  green: "#b3e03a",
  yellow: "#ffc739",
  blue: "#00cde8",
  purple: "#a392e8",
  cyan: "#9deaf6",
  white: "#fcfcfa",
  brightBlack: "#545452",
  brightRed: "#ff7e83",
  brightGreen: "#bee55e",
  brightYellow: "#ffd05e",
  brightBlue: "#1bd5eb",
  brightPurple: "#b0a3eb",
  brightCyan: "#acedf8",
  brightWhite: "#fcfcfa",
  background: "#262427",
  foreground: "#fcfcfa",
  cursorColor: "#fcfcfa",
  selectionBackground: "#fcfcfa",
});

// iTerm2 Solarized Light — see
// vendor/iterm2-color-schemes/windows-terminal/iTerm2 Solarized Light.json.
// This is the exact fixture the fix in this file exists for: its resolved
// body (#5b7179, relative luminance 0.154) and error (#d42a27, relative
// luminance 0.158) sit almost on top of each other, even though each
// individually clears TEXT_MIN_RATIO against ground on its own — so a
// generic key retinted toward body used to land within a hair of error by
// pure coincidence.
const SOLARIZED_LIGHT_SCHEME: Scheme = parseScheme({
  name: "iTerm2 Solarized Light",
  black: "#073642",
  red: "#dc322f",
  green: "#859900",
  yellow: "#b58900",
  blue: "#268bd2",
  purple: "#d33682",
  cyan: "#2aa198",
  white: "#bbb5a2",
  brightBlack: "#002b36",
  brightRed: "#cb4b16",
  brightGreen: "#586e75",
  brightYellow: "#657b83",
  brightBlue: "#839496",
  brightPurple: "#6c71c4",
  brightCyan: "#93a1a1",
  brightWhite: "#fdf6e3",
  background: "#fdf6e3",
  foreground: "#657b83",
  cursorColor: "#657b83",
  selectionBackground: "#eee8d5",
});

// 47 distinct hexes, lifted verbatim from three real vendored schemes'
// slots (Aardvark Blue, 0x96f, Dracula — every field from `black` through
// `selectionBackground`, deduplicated) rather than any single theme's own
// palette, since chips.omp.json's own 47 keys carry only 36 distinct values
// to begin with (several battery/date/wakatime keys share a colour on
// purpose). This is CHM-37's own acceptance criterion: a palette of 47
// distinct colours must yield at least 40 distinct colours after
// recolouring.
const FORTY_SEVEN_DISTINCT_HEXES: readonly string[] = [
  "#191919", "#aa342e", "#4b8c0f", "#dbba00", "#1370d3", "#c43ac3", "#008eb0", "#bebebe",
  "#525252", "#f05b50", "#95dc55", "#ffe763", "#60a4ec", "#e26be2", "#60b6cb", "#f7f7f7",
  "#102040", "#dddddd", "#007acc", "#bfdbfe", "#262427", "#ff666d", "#b3e03a", "#ffc739",
  "#00cde8", "#a392e8", "#9deaf6", "#fcfcfa", "#545452", "#ff7e83", "#bee55e", "#ffd05e",
  "#1bd5eb", "#b0a3eb", "#acedf8", "#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9",
  "#ff79c6", "#8be9fd", "#f8f8f2", "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5",
];

describe("recoloredHexFor", () => {
  it("pins a name that says error, regardless of its current colour", () => {
    const roleHexes = resolveRoleHexes(ZEROX96F_SCHEME);
    // c-badge-return-fail-term is a pale red in chips, but the name alone is
    // reason enough — a name hint never needs the colour it started with.
    expect(recoloredHexFor("c-badge-return-fail-term", "#FF8A80", roleHexes)).toBe(roleHexes.error);
    expect(recoloredHexFor("c-battery-state-error", "#FF867F", roleHexes)).toBe(roleHexes.error);
  });

  it("pins a name that says success, regardless of its current colour", () => {
    const roleHexes = resolveRoleHexes(ZEROX96F_SCHEME);
    expect(recoloredHexFor("c-badge-return-success", "#B2FF59", roleHexes)).toBe(roleHexes.success);
  });

  it("keeps two keys that differed only in hue still differing after recolouring", () => {
    const roleHexes = resolveRoleHexes(ZEROX96F_SCHEME);
    // c-badge-return-custom (purple) and c-git-ahead (cyan) — real chips
    // hex, same rough lightness, different hue.
    const custom = recoloredHexFor("c-badge-return-custom", "#E7B9FF", roleHexes);
    const ahead = recoloredHexFor("c-git-ahead", "#6EFFFF", roleHexes);
    expect(custom).not.toBe(ahead);
  });

  it("keeps two keys that differed only in lightness still differing after recolouring", () => {
    const roleHexes = resolveRoleHexes(ZEROX96F_SCHEME);
    // c-battery-15-less and c-battery-90-less — real chips hex, same rough
    // yellow-green hue family, different lightness.
    const fifteenLess = recoloredHexFor("c-battery-15-less", "#FF8A80", roleHexes);
    const ninetyLess = recoloredHexFor("c-battery-90-less", "#B9F6CA", roleHexes);
    expect(fifteenLess).not.toBe(ninetyLess);
  });

  it("keeps a generic key legible against a role it happens to sit near in luminance (CHM-37)", () => {
    // Solarized Light's own body and error land within 0.004 of each other
    // in relative luminance — this is the exact collision a body-anchored
    // retint used to reproduce for any near-black generic key. Retinting
    // toward the true black/white extreme instead of body is what fixes it.
    const roleHexes = resolveRoleHexes(SOLARIZED_LIGHT_SCHEME);
    const text = recoloredHexFor("c-badge-text", "#212121", roleHexes);
    expect(contrastRatio(text, roleHexes.error)).toBeGreaterThan(2);
  });

  it("a palette of 47 distinct colours yields at least 40 distinct colours after recolouring, across every bundled theme", () => {
    // CHM-37's own acceptance criterion, checked against the full curated
    // library — every theme `ch <slug>` can actually apply — not just one
    // scheme picked to look good.
    const curatedPacks = loadCuratedThemePacks();
    expect(curatedPacks.length).toBeGreaterThan(0);

    for (const pack of curatedPacks) {
      const roleHexes = resolveRoleHexes(pack.payloads["windows-terminal"]);
      const recoloured = FORTY_SEVEN_DISTINCT_HEXES.map((hex, index) => recoloredHexFor(`c-key-${index}`, hex, roleHexes));
      const distinctCount = new Set(recoloured.map((hex) => hex.toLowerCase())).size;
      expect(distinctCount).toBeGreaterThanOrEqual(40);
    }
  });
});
