import { readFileSync } from "node:fs";
import path from "node:path";
import { parseScheme, type Scheme } from "../src/palette/scheme.js";
import { readVendoredScheme } from "./vendor-scheme-library.js";

/**
 * Reads the two vendored sources that are not Windows Terminal scheme JSON —
 * a macOS Terminal.app profile and an Emacs theme — into Schemes the same
 * build pass consumes. Everything here is build-time only, like
 * vendor-scheme-library.ts; see each vendor directory's SOURCE.txt for the
 * pinned commit and why that source was chosen over the theme's own upstream.
 *
 * These exist because two requested themes are absent from
 * mbadolato/iTerm2-Color-Schemes, which supplies every other pack. Adding a
 * source is deliberately more work than adding a curated entry: each one
 * needs its own provenance, licence and reader, so the cost of a second
 * colour source stays visible rather than accumulating quietly.
 */

// Resolved from process.cwd() for the same reason VENDORED_SCHEME_DIR is —
// see the comment there.
const VENDOR_DIR = path.join(process.cwd(), "vendor");
const PAPERCOLOR_DIR = path.join(VENDOR_DIR, "papercolor-terminal-app");
const PAPERCOLOR_THEME_FILE = path.join(VENDOR_DIR, "papercolor-theme", "PaperColor.vim");
const TANGOTANGO_FILE = path.join(VENDOR_DIR, "tangotango", "tangotango-theme.el");
const CYBERDREAM_DIR = path.join(VENDOR_DIR, "cyberdream-nvim");
const BAMBOO_DIR = path.join(VENDOR_DIR, "bamboo-nvim");

/**
 * The vendored scheme supplying TangoTango's bright 8. Emacs' term-color-*
 * faces cover only the normal 8, so the bright row has to come from
 * somewhere; TangoTango declares itself "A color theme based on the Tango
 * Palette colors", and assertTangoBrightRowIsPresent proves that claim
 * against this file before the borrow is made.
 */
const TANGO_BRIGHT_SOURCE_FILE = "Builtin Tango Dark.json";

/** Terminal.app profile key -> the Scheme slot it supplies. */
const TERMINAL_APP_KEY_TO_SLOT: Readonly<Record<string, string>> = {
  ANSIBlackColor: "black",
  ANSIRedColor: "red",
  ANSIGreenColor: "green",
  ANSIYellowColor: "yellow",
  ANSIBlueColor: "blue",
  ANSIMagentaColor: "purple",
  ANSICyanColor: "cyan",
  ANSIWhiteColor: "white",
  ANSIBrightBlackColor: "brightBlack",
  ANSIBrightRedColor: "brightRed",
  ANSIBrightGreenColor: "brightGreen",
  ANSIBrightYellowColor: "brightYellow",
  ANSIBrightBlueColor: "brightBlue",
  ANSIBrightMagentaColor: "brightPurple",
  ANSIBrightCyanColor: "brightCyan",
  ANSIBrightWhiteColor: "brightWhite",
  BackgroundColor: "background",
  TextColor: "foreground",
};

/** Emacs term-color-* face -> the Scheme slot it supplies. These are the normal 8; Emacs defines no bright equivalents. */
const TERM_COLOR_FACE_TO_SLOT: Readonly<Record<string, string>> = {
  "term-color-black": "black",
  "term-color-red": "red",
  "term-color-green": "green",
  "term-color-yellow": "yellow",
  "term-color-blue": "blue",
  "term-color-magenta": "purple",
  "term-color-cyan": "cyan",
  "term-color-white": "white",
};

/** The bright slots taken from TANGO_BRIGHT_SOURCE_FILE, since TangoTango authors no bright row of its own. */
const BRIGHT_SLOT_NAMES = [
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightPurple",
  "brightCyan",
  "brightWhite",
] as const;

/**
 * The bright Tango colours TangoTango uses verbatim somewhere in its own
 * faces. Seven of the eight are present, which is what licenses taking the
 * whole bright row from the Tango scheme; brightCyan (#34e2e2) is the one
 * TangoTango never names, so it is the only borrowed value with no
 * corroboration in the theme itself and is listed here as absent on purpose.
 */
const TANGO_BRIGHT_SLOTS_PRESENT_IN_THEME = [
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightPurple",
  "brightWhite",
] as const;

/**
 * The X11 colour names tangotango-theme.el uses instead of a hex literal,
 * with the values Emacs resolves them to from X11's rgb.txt. Only the names
 * actually read are listed: readNamedOrHexColor throws on anything else, so
 * an upstream edit introducing a new name fails the build instead of
 * silently shipping the wrong colour.
 */
const X11_COLOR_NAMES: Readonly<Record<string, string>> = {
  black: "#000000",
  "dodger blue": "#1e90ff",
  "light cyan": "#e0ffff",
  magenta3: "#cd00cd",
  "dark slate blue": "#483d8b",
};

/**
 * The archived keys holding a colour's channel values, in the order they are
 * preferred. A Terminal.app colour saved in a custom ICC space carries both:
 * NSComponents is what the author entered, NSRGB is Apple's conversion of it
 * into calibrated RGB, and the two disagree by a few counts per channel.
 * NSComponents is the one that reproduces PaperColor's own palette exactly —
 * assertPortMatchesUpstreamPalette is what proves that, and would fail if
 * this preference were reversed. Slots saved in plain calibrated RGB carry
 * NSRGB alone.
 */
const ARCHIVED_COMPONENT_KEYS = ["NSComponents", "NSRGB"] as const;

/** Alacritty `[colors.normal]` / `[colors.bright]` key -> the Scheme slot it supplies. Its "magenta" is the Scheme's "purple"; every other name matches. */
const ALACRITTY_ANSI_KEY_TO_SLOT: Readonly<Record<string, string>> = {
  black: "black",
  red: "red",
  green: "green",
  yellow: "yellow",
  blue: "blue",
  magenta: "purple",
  cyan: "cyan",
  white: "white",
};

/** Matches the `r g b` float triple inside an archived component string; a trailing alpha, where present, is ignored. */
const CHANNEL_COMPONENTS = /([01](?:\.\d+)?)\s+([01](?:\.\d+)?)\s+([01](?:\.\d+)?)/;

/** Terminal.app profile key -> the upstream PaperColor palette key it must equal, for assertPortMatchesUpstreamPalette. */
const PROFILE_KEY_TO_UPSTREAM_PALETTE_KEY: Readonly<Record<string, string>> = {
  ANSIBlackColor: "color00",
  ANSIRedColor: "color01",
  ANSIGreenColor: "color02",
  ANSIYellowColor: "color03",
  ANSIBlueColor: "color04",
  ANSIMagentaColor: "color05",
  ANSICyanColor: "color06",
  ANSIWhiteColor: "color07",
  ANSIBrightBlackColor: "color08",
  ANSIBrightRedColor: "color09",
  ANSIBrightGreenColor: "color10",
  ANSIBrightYellowColor: "color11",
  ANSIBrightBlueColor: "color12",
  ANSIBrightMagentaColor: "color13",
  ANSIBrightCyanColor: "color14",
  ANSIBrightWhiteColor: "color15",
};

const HEX_RADIX = 16;
const MAX_CHANNEL_BYTE = 255;
const HEX_DIGITS_PER_CHANNEL = 2;

/** Reads one PaperColor variant's Terminal.app profile as a Scheme. */
export function readPaperColorScheme(appearance: "dark" | "light"): Scheme {
  const profilePath = path.join(PAPERCOLOR_DIR, `PaperColor-${appearance}.terminal`);
  const profileXml = readFileSync(profilePath, "utf8");

  const slots: Record<string, string> = {};
  for (const [profileKey, slotName] of Object.entries(TERMINAL_APP_KEY_TO_SLOT)) {
    slots[slotName] = readTerminalAppColor(profileXml, profileKey, profilePath);
  }

  assertPortMatchesUpstreamPalette(profileXml, profilePath, appearance);

  // The profile carries no CursorColor and no selection colour at all.
  // Terminal.app's documented fallback for an absent cursor is the text
  // colour, so foreground is a sourced value rather than a guess. There is no
  // equivalent for selection — macOS paints it with the system highlight,
  // which is not a property of the theme — so it is seeded with the scheme's
  // own background. That seed measures 1.0 against ground, which fails
  // SELECTION_MIN_VISIBLE_RATIO and hands the choice to the repair path in
  // resolveSelectionAndBody, which derives a selection from the accent
  // (CHM-38). Seeding it with anything else would be inventing a colour the
  // port does not have; this way the resolver built for the job does it.
  return parseScheme({
    ...slots,
    name: `PaperColor ${appearance === "dark" ? "Dark" : "Light"}`,
    cursorColor: slots.foreground,
    selectionBackground: slots.background,
  });
}

/**
 * Reads one theme author's own Alacritty export as a Scheme. Both themes
 * read this way publish these files themselves, so unlike the PaperColor
 * port there is no upstream to cross-check them against — the export *is*
 * upstream, and its ANSI slots are authoritative and correctly named.
 *
 * Alacritty's format carries the 16 slots as two tables of eight, plus
 * `[colors.primary]` for background and foreground. The two optional pieces
 * are handled the way the Terminal.app profiles' missing ones are:
 *
 * - No `[colors.cursor]` in any file here, so the cursor is seeded from
 *   foreground. Alacritty's own documented default is to draw the cursor in
 *   the inverse of the cell, which is foreground on a normal cell, so this
 *   is the format's own fallback rather than an invention. repairCursorColor
 *   takes it from there.
 * - `[colors.selection]` where the theme sets one; where it does not, the
 *   background is the seed, which measures 1.0 against ground and hands the
 *   choice to resolveSelectionAndBody's repair path (CHM-38) — the same
 *   route readPaperColorScheme relies on, and for the same reason.
 */
export function readAlacrittyScheme(themeDir: string, fileName: string, schemeName: string): Scheme {
  const tomlPath = path.join(themeDir, fileName);
  const toml = readFileSync(tomlPath, "utf8");

  const slots: Record<string, string> = {};
  for (const [alacrittyKey, slotName] of Object.entries(ALACRITTY_ANSI_KEY_TO_SLOT)) {
    slots[slotName] = readAlacrittyColor(toml, "colors.normal", alacrittyKey, tomlPath);
    slots[`bright${slotName[0]!.toUpperCase()}${slotName.slice(1)}`] = readAlacrittyColor(toml, "colors.bright", alacrittyKey, tomlPath);
  }

  const background = readAlacrittyColor(toml, "colors.primary", "background", tomlPath);
  const foreground = readAlacrittyColor(toml, "colors.primary", "foreground", tomlPath);

  return parseScheme({
    ...slots,
    name: schemeName,
    background,
    foreground,
    cursorColor: foreground,
    selectionBackground: readOptionalAlacrittyColor(toml, "colors.selection", "background") ?? background,
  });
}

/** Reads Cyberdream's own Alacritty export for one variant. */
export function readCyberdreamScheme(fileName: string, schemeName: string): Scheme {
  return readAlacrittyScheme(CYBERDREAM_DIR, fileName, schemeName);
}

/** Reads Bamboo's own Alacritty export for one variant. */
export function readBambooScheme(fileName: string, schemeName: string): Scheme {
  return readAlacrittyScheme(BAMBOO_DIR, fileName, schemeName);
}

/**
 * One key from one table of an Alacritty theme. The files are flat tables of
 * `key = "0xRRGGBB"` (single or double quoted), so the table is sliced out by
 * its own header and the key read from within it — a key read from the wrong
 * table would silently ship the bright row as the normal one, which is
 * exactly what slicing first prevents.
 */
function readOptionalAlacrittyColor(toml: string, tableName: string, key: string): string | undefined {
  const tableAt = toml.indexOf(`[${tableName}]`);
  if (tableAt < 0) return undefined;

  const rest = toml.slice(tableAt + tableName.length + 2);
  const nextTableAt = rest.search(/^\s*\[/m);
  const table = nextTableAt < 0 ? rest : rest.slice(0, nextTableAt);

  const authored = new RegExp(`^\\s*${key}\\s*=\\s*['"]0x([0-9a-fA-F]{6})['"]`, "m").exec(table);
  return authored ? `#${authored[1]!.toLowerCase()}` : undefined;
}

function readAlacrittyColor(toml: string, tableName: string, key: string, tomlPath: string): string {
  const authored = readOptionalAlacrittyColor(toml, tableName, key);
  if (authored === undefined) {
    throw new Error(`"${tomlPath}" has no ${key} in [${tableName}]`);
  }
  return authored;
}

/**
 * Proves the Terminal.app port still reproduces the theme it is a port of.
 * Every one of its 16 ANSI slots must equal the matching color00..color15 in
 * the vendored PaperColor.vim, which is the whole justification for shipping
 * a third-party port at all — see vendor/papercolor-theme/SOURCE.txt.
 */
function assertPortMatchesUpstreamPalette(profileXml: string, profilePath: string, appearance: "dark" | "light"): void {
  const upstreamPalette = readUpstreamPaperColorPalette(appearance);

  for (const [profileKey, paletteKey] of Object.entries(PROFILE_KEY_TO_UPSTREAM_PALETTE_KEY)) {
    const portedHex = readTerminalAppColor(profileXml, profileKey, profilePath);
    const upstreamHex = upstreamPalette[paletteKey];
    if (portedHex !== upstreamHex) {
      throw new Error(
        `PaperColor ${appearance}: the port's ${profileKey} is ${portedHex}, but PaperColor.vim's ${paletteKey} is ${upstreamHex} — ` +
          `the port is vendored on the premise that it reproduces upstream exactly, so this must be resolved before it ships`,
      );
    }
  }
}

/**
 * Reads one variant's color00..color15 out of the vendored PaperColor.vim.
 * The palettes are Vim dictionary literals — `'color00' : ['#eeeeee', '255']`
 * — inside `s:themes['default'].light` and `.dark` blocks, so each block is
 * sliced out by its own header before the keys are read, and a missing key
 * throws rather than silently comparing against nothing.
 */
function readUpstreamPaperColorPalette(appearance: "dark" | "light"): Readonly<Record<string, string>> {
  const themeVimScript = readFileSync(PAPERCOLOR_THEME_FILE, "utf8");
  const blockStart = themeVimScript.indexOf(`s:themes['default'].${appearance} = {`);
  if (blockStart < 0) {
    throw new Error(`PaperColor.vim has no s:themes['default'].${appearance} palette block`);
  }

  const otherAppearance = appearance === "dark" ? "light" : "dark";
  const otherStart = themeVimScript.indexOf(`s:themes['default'].${otherAppearance} = {`);
  const blockEnd = otherStart > blockStart ? otherStart : themeVimScript.length;
  const block = themeVimScript.slice(blockStart, blockEnd);

  const palette: Record<string, string> = {};
  for (const paletteKey of Object.values(PROFILE_KEY_TO_UPSTREAM_PALETTE_KEY)) {
    const authored = new RegExp(`'${paletteKey}'\\s*:\\s*\\['(#[0-9a-fA-F]{6})'`).exec(block);
    if (!authored) {
      throw new Error(`PaperColor.vim's ${appearance} palette has no ${paletteKey}`);
    }
    palette[paletteKey] = requireCapture(authored, `PaperColor.vim ${paletteKey}`).toLowerCase();
  }
  return palette;
}

/**
 * Reads TangoTango as a Scheme. The normal 8 are the theme's own
 * term-color-* faces — Emacs' terminal ANSI slots, authored by juba and
 * correctly named, so nothing here has to guess which colour is "red". The
 * bright 8 come from the vendored Tango scheme, and the four chrome values
 * from the theme's default, cursor and region faces. Those four are what
 * make the pack TangoTango rather than Tango: juba re-grounds the palette on
 * #2e3434 instead of black.
 */
export function readTangoTangoScheme(): Scheme {
  const themeLisp = readFileSync(TANGOTANGO_FILE, "utf8");
  const tangoBright = readVendoredScheme(TANGO_BRIGHT_SOURCE_FILE);

  assertTangoBrightRowIsPresent(themeLisp, tangoBright);

  const normalSlots: Record<string, string> = {};
  for (const [faceName, slotName] of Object.entries(TERM_COLOR_FACE_TO_SLOT)) {
    normalSlots[slotName] = readFaceColor(themeLisp, faceName, "foreground");
  }

  const brightSlots: Record<string, string> = {};
  for (const slotName of BRIGHT_SLOT_NAMES) {
    brightSlots[slotName] = tangoBright[slotName];
  }

  return parseScheme({
    ...normalSlots,
    ...brightSlots,
    name: "TangoTango",
    background: readFaceColor(themeLisp, "default", "background"),
    foreground: readFaceColor(themeLisp, "default", "foreground"),
    cursorColor: readFaceColor(themeLisp, "cursor", "background"),
    selectionBackground: readFaceColor(themeLisp, "region", "background"),
  });
}

/**
 * Proves TangoTango really is the Tango palette before its bright row is
 * borrowed from a different file. Every slot listed as present must appear
 * verbatim somewhere in the theme; if upstream ever recolours one, the build
 * fails rather than silently pairing a Tango bright row with a palette that
 * has drifted away from it.
 */
function assertTangoBrightRowIsPresent(themeLisp: string, tangoBright: Scheme): void {
  const lowercasedTheme = themeLisp.toLowerCase();
  for (const slotName of TANGO_BRIGHT_SLOTS_PRESENT_IN_THEME) {
    const tangoHex = tangoBright[slotName].toLowerCase();
    if (!lowercasedTheme.includes(tangoHex)) {
      throw new Error(
        `${TANGO_BRIGHT_SOURCE_FILE}'s ${slotName} (${tangoHex}) no longer appears in tangotango-theme.el — ` +
          `the pack borrows that scheme's bright row on the premise that the two palettes share it, so this must be resolved before it ships`,
      );
    }
  }
}

/**
 * Reads one colour out of a Terminal.app profile. Each value is a base64
 * NSKeyedArchiver blob whose colour content is an ASCII float string, so the
 * string is read directly rather than by decoding the binary plist around it
 * — a full bplist reader would be a dependency, or a hundred lines for one
 * value, and this fails loudly if the shape ever changes.
 */
function readTerminalAppColor(profileXml: string, profileKey: string, profilePath: string): string {
  const keyed = new RegExp(`<key>${profileKey}</key>\\s*<data>([\\s\\S]*?)</data>`).exec(profileXml);
  if (!keyed) {
    throw new Error(`"${profilePath}" has no <data> value for key "${profileKey}"`);
  }

  const encoded = requireCapture(keyed, `${profilePath} key ${profileKey}`);
  const archived = Buffer.from(encoded.replace(/\s+/g, ""), "base64").toString("latin1");
  for (const componentKey of ARCHIVED_COMPONENT_KEYS) {
    const channels = readArchivedChannels(archived, componentKey);
    if (channels) return channels;
  }

  throw new Error(
    `"${profilePath}" key "${profileKey}" holds none of ${ARCHIVED_COMPONENT_KEYS.join(", ")} in a readable form`,
  );
}

/** Reads the channel triple following one archived key, or null when that key is absent from this colour. */
function readArchivedChannels(archived: string, componentKey: string): string | null {
  const keyAt = archived.indexOf(componentKey);
  if (keyAt < 0) return null;

  const components = CHANNEL_COMPONENTS.exec(archived.slice(keyAt));
  if (!components) return null;

  const red = components[1];
  const green = components[2];
  const blue = components[3];
  if (red === undefined || green === undefined || blue === undefined) return null;

  return `#${[red, green, blue].map(toHexChannel).join("")}`;
}

function toHexChannel(component: string): string {
  return Math.round(Number(component) * MAX_CHANNEL_BYTE)
    .toString(HEX_RADIX)
    .padStart(HEX_DIGITS_PER_CHANNEL, "0");
}

/**
 * Reads one attribute of one face from an Emacs theme. Every face read here
 * is written as a single flat attribute list — `(face ((t (:foreground
 * "#..." :background "#..."))))` — so the list is matched up to its first
 * closing paren rather than by parsing Lisp, and a face written any other
 * way throws instead of matching something unintended.
 */
function readFaceColor(themeLisp: string, faceName: string, attribute: "foreground" | "background"): string {
  const face = new RegExp(`\`\\(${escapeForRegExp(faceName)} \\(\\(t \\(([^)]*)\\)`).exec(themeLisp);
  if (!face) {
    throw new Error(`tangotango-theme.el has no simple attribute list for face "${faceName}"`);
  }

  const attributes = requireCapture(face, `tangotango-theme.el face "${faceName}"`);
  const authored = new RegExp(`:${attribute} "([^"]+)"`).exec(attributes);
  if (!authored) {
    throw new Error(`tangotango-theme.el face "${faceName}" has no :${attribute}`);
  }

  return readNamedOrHexColor(requireCapture(authored, `tangotango-theme.el face "${faceName}" :${attribute}`), faceName);
}

function readNamedOrHexColor(authored: string, faceName: string): string {
  if (authored.startsWith("#")) return authored.toLowerCase();

  const named = X11_COLOR_NAMES[authored.toLowerCase()];
  if (!named) {
    throw new Error(
      `tangotango-theme.el face "${faceName}" names the colour "${authored}", which is not in X11_COLOR_NAMES — add it with its rgb.txt value`,
    );
  }
  return named;
}

/**
 * The first capture group of a match that has already been checked for
 * existence. A pattern that matched but captured nothing is a broken pattern
 * rather than a missing colour, so it throws here instead of returning a
 * value the caller would have to re-check.
 */
function requireCapture(match: RegExpExecArray, describe: string): string {
  const captured = match[1];
  if (captured === undefined) {
    throw new Error(`${describe}: pattern matched but captured nothing`);
  }
  return captured;
}

function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
