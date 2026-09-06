import { readVendoredScheme } from "./tools/vendor-scheme-library.js";
import { resolveRoleHexes } from "./dist/palette/repair.js";
import { resolveSelectionAndBody } from "./dist/palette/selection.js";
import { resolveActiveRowAndText, ACTIVE_ROW_IDEAL_FRACTION } from "./dist/palette/surfaces.js";

const CURATED = [
  ["GitHub Dark Default.json","github-dark"],["GitHub Light Default.json","github-light"],
  ["One Half Dark.json","one-half-dark"],["One Half Light.json","one-half-light"],
  ["Ayu Mirage.json","ayu-dark"],["Ayu Light.json","ayu-light"],
  ["Night Owl.json","night-owl-dark"],["Night Owlish Light.json","night-owl-light"],
  ["TokyoNight Night.json","tokyo-night-dark"],["TokyoNight Day.json","tokyo-night-light"],
  ["Catppuccin Mocha.json","catppuccin-dark"],["Catppuccin Latte.json","catppuccin-light"],
  ["Nord.json","nord-dark"],["Nord Light.json","nord-light"],
  ["Gruvbox Dark.json","gruvbox-dark"],["Gruvbox Light.json","gruvbox-light"],
  ["Rose Pine.json","rose-pine-dark"],["Rose Pine Dawn.json","rose-pine-light"],
  ["iTerm2 Solarized Dark.json","solarized-dark"],["iTerm2 Solarized Light.json","solarized-light"],
  ["Kanagawa Wave.json","kanagawa-dark"],["Kanagawa Lotus.json","kanagawa-light"],
  ["Everforest Dark Med.json","everforest-dark"],["Everforest Light Med.json","everforest-light"],
  ["Dracula.json","dracula-dark"],["Monokai Classic.json","monokai-dark"],
  ["Jellybeans.json","jellybeans"],["Shades Of Purple.json","shades-of-purple"],
  ["Ayu.json","ayu-dark-deep"],
];

let mismatches = 0;
for (const [fileName, slug] of CURATED) {
  const scheme = readVendoredScheme(fileName);
  const roleHexes = resolveRoleHexes(scheme);
  const { selection, body } = resolveSelectionAndBody(
    scheme.selectionBackground, roleHexes.ground, roleHexes.body, roleHexes.accent,
    [roleHexes.success, roleHexes.error],
  );
  const rowAndText = resolveActiveRowAndText(roleHexes.ground, body.hex, roleHexes.muted, [selection.hex], ACTIVE_ROW_IDEAL_FRACTION);
  const match = rowAndText.textHex === body.hex;
  if (!match) {
    mismatches++;
    console.log(`${slug}: body.hex=${body.hex} textHex=${rowAndText.textHex} DIFFERS`);
  }
}
console.log(`checked ${CURATED.length} packs, ${mismatches} where textHex != body.hex`);
