import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ROLES, type Role } from "../constants.js";
import { mix, rgbDistance } from "../palette/color.js";
import { resolveRoleHexes } from "../palette/repair.js";
import { resolveSelectionAndBody } from "../palette/selection.js";
import type { Scheme } from "../palette/scheme.js";
import { detectLineEnding } from "./marked-json-edit.js";
import { herdrConfigPath } from "./platform.js";

/** Suffix for the pre-apply copy of config.toml that `undoHerdr` restores from. */
const BACKUP_FILE_SUFFIX = ".chameleon-backup";

/**
 * Every edit this adapter makes inside a table it owns ([theme.custom] and
 * [ui] — see upsertMarkedTokens) is wrapped in this pair, so a rerun can find
 * and replace its own entries without disturbing any override the user wrote
 * there themselves. TOML's comment syntax is `#`, same as the marker this
 * project already uses for the PowerShell profile — see oh-my-posh.ts.
 */
const MARKER_BEGIN = "# ch:begin";
const MARKER_END = "# ch:end";

/** The binary and subcommand Herdr's own docs give for a live reload — a call over Herdr's control socket, never a relaunch. See reloadHerdr. */
const HERDR_BINARY_NAME = "herdr";
const RELOAD_CONFIG_ARGS = ["server", "reload-config"] as const;

/**
 * The slice of Herdr's config.toml this adapter actually depends on.
 * [ui]'s own behaviour settings (status-bar, pane border style, …) are never
 * parsed and never touched; [ui].accent is the one exception — see CHM-23 —
 * and is read back the same way [theme.custom] is. This schema exists only
 * to describe the shape this adapter reads back out, never to police the
 * rest of a user's config.
 */
const HerdrConfigSchema = z.object({
  theme: z.object({
    name: z.string().optional(),
    custom: z.record(z.string(), z.string()),
  }),
  ui: z.object({
    accent: z.string().optional(),
  }),
});

export type HerdrConfig = z.infer<typeof HerdrConfigSchema>;

export interface HerdrAdapter {
  detect(): boolean;
  read(): HerdrConfig;
  apply(scheme: Scheme, slug: string): void;
  /** Returns a one-sentence notice when there was nothing running to reload — see reloadHerdr's own "server_not_running" handling (CHM-45) — or undefined once the reload actually took. */
  reload(): string | undefined;
}

/**
 * Herdr's own built-in theme names, copied verbatim from the "valid themes:"
 * list Herdr itself prints when `[theme].name` names something it does not
 * recognise (`theme.name = "definitely-not-a-theme"; using "catppuccin"`,
 * with `"status":"partial"` — see this ticket's body, CHM-28). This is the
 * authoritative list — not a table Chameleon invented and could let drift —
 * and herdrThemeNameFor below is checked against it on every apply, so a
 * typo or a renamed Herdr built-in fails loudly instead of writing a name
 * Herdr silently falls back from.
 */
const HERDR_BUILTIN_THEME_NAMES: ReadonlySet<string> = new Set([
  "catppuccin",
  "catppuccin-latte",
  "terminal",
  "tokyo-night",
  "tokyo-night-day",
  "dracula",
  "nord",
  "gruvbox",
  "gruvbox-light",
  "one-dark",
  "one-light",
  "solarized",
  "solarized-light",
  "kanagawa",
  "kanagawa-lotus",
  "rose-pine",
  "rose-pine-dawn",
  "vesper",
]);

/**
 * Chameleon pack slug → Herdr's own built-in theme slug, for the packs whose
 * upstream family already ships as one — every value here must be a member
 * of HERDR_BUILTIN_THEME_NAMES above. "Catppuccin Mocha" (the Windows
 * Terminal scheme's display name Chameleon used to write verbatim) was
 * never one of these: Herdr's built-in is named `catppuccin`, and it
 * silently ignores anything else — see CHM-21.
 *
 * A slug absent from this table — ayu, everforest, github, monokai,
 * night-owl, and nord-light, plus any user-supplied pack — has no Herdr
 * built-in at all (see CHM-28). Its `name` falls back to whichever built-in
 * has the nearest ground by RGB distance (see nearestHerdrBuiltinThemeNameFor
 * below); its own colours still reach Herdr through the full [theme.custom]
 * token set regardless, via upsertCustomBlock, so the theme visibly changes
 * either way.
 */
const PACK_SLUG_TO_HERDR_THEME: Readonly<Record<string, string>> = {
  "catppuccin-dark": "catppuccin",
  "catppuccin-light": "catppuccin-latte",
  "tokyo-night-dark": "tokyo-night",
  "tokyo-night-light": "tokyo-night-day",
  "dracula-dark": "dracula",
  "nord-dark": "nord",
  "gruvbox-dark": "gruvbox",
  "gruvbox-light": "gruvbox-light",
  "one-half-dark": "one-dark",
  "one-half-light": "one-light",
  "solarized-dark": "solarized",
  "solarized-light": "solarized-light",
  "kanagawa-dark": "kanagawa",
  "kanagawa-light": "kanagawa-lotus",
  "rose-pine-dark": "rose-pine",
  "rose-pine-light": "rose-pine-dawn",
};

/**
 * Ground colour for every one of Herdr's own built-ins, keyed by the same
 * name written to [theme].name — the only thing nearestHerdrBuiltinThemeNameFor
 * below needs to pick the closest one for a pack with no family match (CHM-41).
 * Herdr's CLI has no command that reports a built-in's own colours (its only
 * relevant diagnostic is the bare name list — see HERDR_BUILTIN_THEME_NAMES),
 * so these are pinned by hand:
 *
 * - Sixteen of the eighteen are the background of the Chameleon pack that
 *   shares the built-in's own upstream family — see PACK_SLUG_TO_HERDR_THEME
 *   and themes/<slug>.json — since Herdr's built-in and Chameleon's bundled
 *   pack both trace back to the same original colour scheme.
 * - "terminal", Herdr's generic non-family dark theme, is pure black — see
 *   this ticket's own body (CHM-41) for the reasoning: it's what every
 *   unmatched pack fell back to before this fix.
 * - "vesper" has no Chameleon family at all; its ground is taken from
 *   Rauno Freiberg's Vesper theme (https://github.com/raunofreiberg/vesper),
 *   which is the theme Herdr's own built-in is named after.
 */
export const HERDR_BUILTIN_GROUNDS: Readonly<Record<string, string>> = {
  catppuccin: "#1e1e2e",
  "catppuccin-latte": "#eff1f5",
  terminal: "#000000",
  "tokyo-night": "#1a1b26",
  "tokyo-night-day": "#e1e2e7",
  dracula: "#282a36",
  nord: "#2e3440",
  gruvbox: "#282828",
  "gruvbox-light": "#fbf1c7",
  "one-dark": "#282c34",
  "one-light": "#fafafa",
  solarized: "#002b36",
  "solarized-light": "#fdf6e3",
  kanagawa: "#1f1f28",
  "kanagawa-lotus": "#f2ecbc",
  "rose-pine": "#191724",
  "rose-pine-dawn": "#faf4ed",
  vesper: "#101010",
};

interface HerdrBuiltinGroundDistance {
  readonly themeName: string;
  readonly distance: number;
}

/**
 * Herdr's own built-in whose ground is nearest `groundHex` by RGB distance
 * (see rgbDistance) — the fallback for a pack whose slug has no entry in
 * PACK_SLUG_TO_HERDR_THEME. Replaces the old generic terminal/one-light
 * fallback (CHM-41): with 18 built-ins to choose from, something in the
 * same colour family is almost always closer than a flat black or white,
 * and it's the tab bar, borders and cursor — none of them reachable by
 * [theme.custom] or [ui].accent — that this closeness is actually for.
 *
 * Exported so a test can assert the acceptance criterion directly — every
 * bundled pack's chosen base within a stated RGB distance of its own ground
 * — without re-deriving this file's own selection logic.
 */
export function nearestHerdrBuiltinThemeNameFor(groundHex: string): string {
  const distances: HerdrBuiltinGroundDistance[] = Object.entries(HERDR_BUILTIN_GROUNDS).map(([themeName, builtinGroundHex]) => ({
    themeName,
    distance: rgbDistance(groundHex, builtinGroundHex),
  }));
  return distances.reduce((nearest, candidate) => (candidate.distance < nearest.distance ? candidate : nearest)).themeName;
}

/**
 * The Herdr theme name to write for `slug` — its own built-in when one
 * exists, otherwise whichever built-in's ground is nearest `groundHex` (see
 * nearestHerdrBuiltinThemeNameFor). Always a name real Herdr accepts: checked
 * against HERDR_BUILTIN_THEME_NAMES rather than trusted, so an edit to either
 * table above that introduces a name Herdr does not recognise fails at apply
 * time instead of writing a theme Herdr itself would reject.
 */
function herdrThemeNameFor(slug: string, groundHex: string): string {
  const themeName = PACK_SLUG_TO_HERDR_THEME[slug] ?? nearestHerdrBuiltinThemeNameFor(groundHex);
  if (!HERDR_BUILTIN_THEME_NAMES.has(themeName)) {
    throw new Error(`"${themeName}" is not one of Herdr's own built-in themes — see HERDR_BUILTIN_THEME_NAMES`);
  }
  return themeName;
}

/**
 * Chameleon's own six roles → the real [theme.custom] tokens Herdr's own
 * default config documents. Herdr does not recognise `ground`, `body`,
 * `muted`, `success` or `error` — those were invented, and Herdr silently
 * dropped all five (see CHM-21). Only `accent` was ever a real token.
 *
 * This covers 6 of the 19 tokens Herdr's [theme.custom] actually accepts
 * (established by probing `herdr config check` — see CHM-28's ticket body);
 * the remaining 13 have no Chameleon role to key off and are derived
 * directly from the scheme instead — see structuralTokenValues and
 * extraAccentTokenValues below.
 */
const ROLE_TO_HERDR_TOKEN: Readonly<Record<Role, string>> = {
  ground: "sidebar_bg",
  body: "text",
  accent: "accent",
  muted: "subtext0",
  success: "green",
  error: "red",
};

/**
 * Every token Herdr's [theme.custom] table honours — established by probing
 * `herdr config check`, which reports "unknown config key theme.custom.X;
 * ignoring key" for anything outside this set (see CHM-28's ticket body).
 * 19 tokens, not the 7 Herdr's own default config happens to mention.
 *
 * Chameleon must never write a key outside this set: CHM-21 already showed
 * what happens when it does — Herdr accepts the file and silently drops
 * every key it does not recognise, so the mistake never surfaces on its
 * own. assertOnlyAcceptedHerdrTokens is the guard that catches it instead.
 */
const HERDR_ACCEPTED_CUSTOM_TOKENS: ReadonlySet<string> = new Set([
  "sidebar_bg",
  "active_row_bg",
  "selection_bg",
  "panel_bg",
  "surface_dim",
  "surface0",
  "surface1",
  "overlay0",
  "overlay1",
  "text",
  "subtext0",
  "accent",
  "red",
  "green",
  "blue",
  "mauve",
  "peach",
  "teal",
  "yellow",
]);

/**
 * Whether `config`'s own [theme.custom] tokens and [ui] accent already carry
 * every one of `roleHexes`' six role values, under Herdr's own token names —
 * the same keys customTokenValues and upsertUiAccent themselves write on
 * apply, so a mismatch means this target has drifted from whatever pack `ch`
 * last recorded as active. See CHM-27.
 */
export function herdrMatchesRoleHexes(config: HerdrConfig, roleHexes: Readonly<Record<Role, string>>): boolean {
  const customTokensMatch = ROLES.every((role) => config.theme.custom[ROLE_TO_HERDR_TOKEN[role]] === roleHexes[role]);
  return customTokensMatch && config.ui.accent === roleHexes.accent;
}

function assertOnlyAcceptedHerdrTokens(tokenValues: Readonly<Record<string, string>>): void {
  for (const token of Object.keys(tokenValues)) {
    if (!HERDR_ACCEPTED_CUSTOM_TOKENS.has(token)) {
      throw new Error(`"${token}" is not one of Herdr's own [theme.custom] tokens — see HERDR_ACCEPTED_CUSTOM_TOKENS`);
    }
  }
}

/**
 * Fractions of the way from ground to body (see mix in palette/color.ts)
 * that make up Herdr's neutral surface scale — its token names borrow
 * Catppuccin's, running from nearest ground to nearest body. Evenly spaced
 * rather than tuned per theme: these tokens never carry text, so the scale
 * only needs to read as a ramp, not clear any particular contrast ratio.
 */
const SURFACE_DIM_FRACTION = 1 / 6;
const SURFACE_0_FRACTION = 2 / 6;
const SURFACE_1_FRACTION = 3 / 6;
const OVERLAY_0_FRACTION = 4 / 6;
const OVERLAY_1_FRACTION = 5 / 6;

/** Herdr's neutral surface scale, walking from ground toward body — see SURFACE_DIM_FRACTION and friends. */
function surfaceScale(groundHex: string, bodyHex: string): Record<string, string> {
  return {
    surface_dim: mix(groundHex, bodyHex, SURFACE_DIM_FRACTION),
    surface0: mix(groundHex, bodyHex, SURFACE_0_FRACTION),
    surface1: mix(groundHex, bodyHex, SURFACE_1_FRACTION),
    overlay0: mix(groundHex, bodyHex, OVERLAY_0_FRACTION),
    overlay1: mix(groundHex, bodyHex, OVERLAY_1_FRACTION),
  };
}

/**
 * Herdr's structural background tokens beyond `sidebar_bg` (ground) and
 * `text` (body) — the ones CHM-28 exists to fix: without them, a pack with
 * no Herdr built-in left every panel and row painted in the fallback
 * theme's own colours, with only the accent actually changing.
 *
 * `selection_bg` is `resolveSelectionAndBody`'s own output, not the
 * scheme's raw selectionBackground passed through — see CHM-30:
 * GitHub Light's authored selection colour is literally its own body
 * colour, invisible as a highlight and unreadable underneath it at once,
 * and passing that straight through would ship the same bug into Herdr
 * that CHM-30 exists to fix.
 */
function structuralTokenValues(groundHex: string, bodyHex: string, selectionHex: string): Record<string, string> {
  return {
    panel_bg: groundHex,
    // An active row reads as a slightly raised surface — the same tone as
    // surface0, not a colour of its own.
    active_row_bg: mix(groundHex, bodyHex, SURFACE_0_FRACTION),
    selection_bg: selectionHex,
    ...surfaceScale(groundHex, bodyHex),
  };
}

/**
 * Herdr's four extra accent tokens beyond Chameleon's own accent/success/
 * error roles, drawn straight from the scheme's own base ANSI slots — the
 * same slots role assignment measures from (see BASE_COLOR_SLOTS in
 * palette/roles.ts) but taken at face value here, the way ground and body
 * already are. These are supplementary swatches Herdr paints labels and
 * badges with, not text that must clear a contrast floor.
 *
 * No ANSI slot is orange, so `peach` is approximated as the midpoint
 * between the two slots that bracket it on the colour wheel.
 */
function extraAccentTokenValues(scheme: Scheme): Record<string, string> {
  return {
    blue: scheme.blue,
    teal: scheme.cyan,
    mauve: scheme.purple,
    yellow: scheme.yellow,
    peach: mix(scheme.red, scheme.yellow, 0.5),
  };
}

/**
 * The one colour key under [ui] — Herdr's own docs call it "Accent color for
 * highlights, borders, and navigation UI", and it is what pane and sidebar
 * borders actually read. It shares its name with, but is a different key in
 * a different table from, [theme.custom]'s `accent` (ROLE_TO_HERDR_TOKEN.accent
 * above). Chameleon set the latter and never the former — CHM-23 — leaving
 * borders stuck on whatever the user had here before.
 */
const UI_ACCENT_KEY = "accent";

/** Where Herdr keeps config.toml — see platform.ts's herdrConfigPath. */
function defaultConfigPath(): string | undefined {
  return herdrConfigPath();
}

function requireConfigPath(configPath: string | undefined): string {
  if (!configPath) {
    throw new Error("APPDATA is not set — cannot locate Herdr's config.toml");
  }
  return configPath;
}

function backupPathFor(configPath: string): string {
  return `${configPath}${BACKUP_FILE_SUFFIX}`;
}

function detectHerdr(configPath: string | undefined): boolean {
  return configPath !== undefined && existsSync(configPath);
}

// --- Minimal TOML table/line scanning -------------------------------------
//
// Herdr's config.toml is never fully parsed: this adapter depends on
// exactly three tables ([theme], [theme.custom] and [ui]), all flat string
// maps, so a hand-rolled line scan is enough to find and edit them without
// dragging in a general-purpose TOML parser this project has no other use
// for. See code-standards.md, "Dependencies".

const TABLE_HEADER_REGEX = /^\s*\[([^[\]]+)\]\s*(#.*)?$/;
const STRING_KEY_VALUE_REGEX = /^\s*([A-Za-z0-9_.-]+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*(#.*)?$/;

interface TomlTableRange {
  readonly bodyStartLineIndex: number;
  readonly bodyEndLineIndex: number;
}

function tableHeaderName(line: string): string | undefined {
  return TABLE_HEADER_REGEX.exec(line)?.[1]?.trim();
}

/** The line range of `tableName`'s own body — everything after its header, up to the next table header or end of file. */
function findTable(lines: readonly string[], tableName: string): TomlTableRange | undefined {
  const headerLineIndex = lines.findIndex((line) => tableHeaderName(line) === tableName);
  if (headerLineIndex === -1) return undefined;

  const bodyStartLineIndex = headerLineIndex + 1;
  const nextHeaderOffset = lines.slice(bodyStartLineIndex).findIndex((line) => tableHeaderName(line) !== undefined);
  const bodyEndLineIndex = nextHeaderOffset === -1 ? lines.length : bodyStartLineIndex + nextHeaderOffset;

  return { bodyStartLineIndex, bodyEndLineIndex };
}

function unescapeBasicString(value: string): string {
  return value.replace(/\\(.)/g, "$1");
}

/** The value of `key = "…"` among `bodyLines`, tolerating only the double-quoted basic strings this adapter ever reads or writes. */
function extractStringValue(bodyLines: readonly string[], key: string): string | undefined {
  for (const line of bodyLines) {
    const match = STRING_KEY_VALUE_REGEX.exec(line);
    if (match?.[1] === key) {
      return unescapeBasicString(match[2] ?? "");
    }
  }
  return undefined;
}

/** Every `key = "…"` pair among `bodyLines`, skipping Chameleon's own marker comments. */
function extractStringKeyValues(bodyLines: readonly string[]): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const line of bodyLines) {
    const trimmedLine = line.trim();
    if (trimmedLine === MARKER_BEGIN || trimmedLine === MARKER_END) continue;

    const match = STRING_KEY_VALUE_REGEX.exec(line);
    const key = match?.[1];
    const value = match?.[2];
    if (key === undefined || value === undefined) continue;
    entries[key] = unescapeBasicString(value);
  }
  return entries;
}

/**
 * Parses config.toml down to the [theme] table this adapter depends on. A
 * config missing that table entirely must say so by name, never crash and
 * never be silently overwritten.
 */
function readHerdrConfig(configPath: string): HerdrConfig {
  const rawText = readFileSync(configPath, "utf8");
  const lines = rawText.split(/\r\n|\n/);

  const themeTable = findTable(lines, "theme");
  if (!themeTable) {
    throw new Error(`${configPath} is not a Herdr config Chameleon understands: missing a [theme] table`);
  }
  const themeBodyLines = lines.slice(themeTable.bodyStartLineIndex, themeTable.bodyEndLineIndex);

  const customTable = findTable(lines, "theme.custom");
  const customBodyLines = customTable ? lines.slice(customTable.bodyStartLineIndex, customTable.bodyEndLineIndex) : [];

  const uiTable = findTable(lines, "ui");
  const uiBodyLines = uiTable ? lines.slice(uiTable.bodyStartLineIndex, uiTable.bodyEndLineIndex) : [];

  const shape = {
    theme: {
      name: extractStringValue(themeBodyLines, "name"),
      custom: extractStringKeyValues(customBodyLines),
    },
    ui: {
      accent: extractStringValue(uiBodyLines, UI_ACCENT_KEY),
    },
  };
  const validated = HerdrConfigSchema.safeParse(shape);
  if (!validated.success) {
    throw new Error(`${configPath} is not a Herdr config Chameleon understands: ${validated.error.message}`);
  }
  return validated.data;
}

function spliceTableBody(lines: readonly string[], table: TomlTableRange, updatedBodyLines: readonly string[], eol: string): string {
  return [...lines.slice(0, table.bodyStartLineIndex), ...updatedBodyLines, ...lines.slice(table.bodyEndLineIndex)].join(eol);
}

/** Appends a fresh `[tableName]` table at the end of `text`, for the config that does not have one yet. */
function appendTable(text: string, eol: string, tableName: string, bodyLines: readonly string[]): string {
  const tableText = `[${tableName}]${eol}${bodyLines.join(eol)}${eol}`;
  if (text.length === 0) return tableText;
  const separator = text.endsWith(eol) ? eol : eol + eol;
  return `${text}${separator}${tableText}`;
}

const NAME_LINE_REGEX = /^\s*name\s*=.*$/;

function buildNameLine(themeName: string): string {
  return `name = ${JSON.stringify(themeName)}`;
}

/**
 * Sets [theme]'s own `name` to `themeName`, replacing a pre-existing value
 * in place — never marker-scoped, since a table can hold only one `name`
 * key and there is nothing else of Chameleon's to track there.
 */
function upsertThemeName(text: string, eol: string, themeName: string): string {
  const lines = text.split(eol);
  const themeTable = findTable(lines, "theme");
  if (!themeTable) {
    return appendTable(text, eol, "theme", [buildNameLine(themeName)]);
  }

  const bodyLines = lines.slice(themeTable.bodyStartLineIndex, themeTable.bodyEndLineIndex);
  const existingIndex = bodyLines.findIndex((line) => NAME_LINE_REGEX.test(line));
  const updatedBodyLines =
    existingIndex === -1
      ? [buildNameLine(themeName), ...bodyLines]
      : bodyLines.map((line, index) => (index === existingIndex ? buildNameLine(themeName) : line));

  return spliceTableBody(lines, themeTable, updatedBodyLines, eol);
}

/** `token = "value"` for every entry of `tokenValues`, in the object's own key order. */
function buildTokenLines(tokenValues: Readonly<Record<string, string>>): string[] {
  return Object.entries(tokenValues).map(([token, value]) => `${token} = ${JSON.stringify(value)}`);
}

/** `key = "…"` capturing everything before and after the quoted value, so the value can be swapped without disturbing indentation, key spacing or a trailing comment. */
const STRING_KEY_VALUE_REPLACE_REGEX = /^(\s*[A-Za-z0-9_.-]+\s*=\s*)"(?:[^"\\]|\\.)*"(\s*(?:#.*)?)$/;

/** `line`, with its quoted value swapped for `newValue` — everything else on the line, trailing comment included, is left exactly as written. */
function replaceStringValue(line: string, newValue: string): string {
  return line.replace(STRING_KEY_VALUE_REPLACE_REGEX, (_match, prefix: string, suffix: string) => `${prefix}${JSON.stringify(newValue)}${suffix}`);
}

/**
 * Rewrites, in place, the value of any line among `lines` whose key is one of
 * `tokenValues`' own keys — the line itself, and any comment on it or above
 * it, never moves. Returns which keys were found this way, so the caller can
 * leave them out of the marked block it is about to (re)write instead of
 * writing a second copy of the same key.
 *
 * This is the fix for CHM-22: a user who already had `text` set further down
 * [theme.custom] ended up with two `text` keys once Chameleon's marked block
 * added its own — TOML forbids that, so Herdr rejected the whole file.
 * Updating in place, rather than deleting the line and re-adding it inside
 * the marker, is also what keeps the user's own comment on that line —
 * often the reason they picked that colour — attached to it.
 */
function takeOverExistingTokenLines(
  lines: readonly string[],
  tokenValues: Readonly<Record<string, string>>,
): { updatedLines: string[]; ownedTokens: Set<string> } {
  const ownedTokens = new Set<string>();
  const updatedLines = lines.map((line) => {
    const key = STRING_KEY_VALUE_REGEX.exec(line)?.[1];
    const value = key === undefined ? undefined : tokenValues[key];
    if (key === undefined || value === undefined) return line;
    ownedTokens.add(key);
    return replaceStringValue(line, value);
  });
  return { updatedLines, ownedTokens };
}

/** The entries of `tokenValues` whose key is not already claimed by a plain line the user wrote — i.e. the keys the marked block still needs to carry itself. */
function tokensNotOwned(tokenValues: Readonly<Record<string, string>>, ownedTokens: ReadonlySet<string>): Record<string, string> {
  return Object.fromEntries(Object.entries(tokenValues).filter(([token]) => !ownedTokens.has(token)));
}

/**
 * Upserts `tokenValues` into `tableName`'s own body, scoped between
 * ch:begin/ch:end. A user's own entries in the same table — outside the
 * marker — are never touched, so a config that already carries hand-picked
 * entries keeps them across every apply. When one of those outside-the-marker
 * lines already sets a key `tokenValues` itself owns, that line is updated in
 * place instead — see takeOverExistingTokenLines — so the table never ends up
 * with two of it.
 *
 * Shared by [theme.custom] (Chameleon's six roles, under Herdr's own token
 * names — see upsertCustomBlock) and [ui] (just `accent` — see
 * upsertUiAccent, CHM-23): both are "one table, a handful of colour keys
 * Chameleon owns, everything else in the table left alone", and the
 * take-over-in-place behaviour is the same fix for the same TOML-forbids-
 * duplicate-keys problem either way.
 */
function upsertMarkedTokens(text: string, eol: string, tableName: string, tokenValues: Readonly<Record<string, string>>): string {
  const lines = text.split(eol);
  const table = findTable(lines, tableName);

  if (!table) {
    const markedLines = [MARKER_BEGIN, ...buildTokenLines(tokenValues), MARKER_END];
    return appendTable(text, eol, tableName, markedLines);
  }

  const bodyLines = lines.slice(table.bodyStartLineIndex, table.bodyEndLineIndex);
  const beginIndex = bodyLines.findIndex((line) => line.trim() === MARKER_BEGIN);

  if (beginIndex === -1) {
    const { updatedLines, ownedTokens } = takeOverExistingTokenLines(bodyLines, tokenValues);
    const markedLines = [MARKER_BEGIN, ...buildTokenLines(tokensNotOwned(tokenValues, ownedTokens)), MARKER_END];
    return spliceTableBody(lines, table, [...markedLines, ...updatedLines], eol);
  }

  const endIndex = bodyLines.findIndex((line, index) => index > beginIndex && line.trim() === MARKER_END);
  if (endIndex === -1) {
    throw new Error(
      `config.toml has a ch:begin marker in [${tableName}] with no matching ch:end — refusing to guess where Chameleon's block ends`,
    );
  }

  // Only the lines outside Chameleon's own current marker are candidates for
  // "the user already has this key" — the marker's own lines are about to be
  // replaced wholesale regardless, so scanning them too would just make this
  // rewrite think it "found" its own previous values.
  const before = takeOverExistingTokenLines(bodyLines.slice(0, beginIndex), tokenValues);
  const after = takeOverExistingTokenLines(bodyLines.slice(endIndex + 1), tokenValues);
  const ownedTokens = new Set([...before.ownedTokens, ...after.ownedTokens]);
  const markedLines = [MARKER_BEGIN, ...buildTokenLines(tokensNotOwned(tokenValues, ownedTokens)), MARKER_END];

  const updatedBodyLines = [...before.updatedLines, ...markedLines, ...after.updatedLines];
  return spliceTableBody(lines, table, updatedBodyLines, eol);
}

/**
 * Every [theme.custom] token value Chameleon writes: the six roles under
 * Herdr's own token names (see ROLE_TO_HERDR_TOKEN), the resolved selection
 * highlight (see structuralTokenValues), plus the structural and
 * extra-accent tokens derived straight from `scheme` and `colorTable`'s
 * ground/body — see structuralTokenValues and extraAccentTokenValues. Every
 * key is asserted against HERDR_ACCEPTED_CUSTOM_TOKENS before it reaches the
 * config, so a future addition that invents a token fails immediately
 * instead of shipping a key Herdr silently ignores (CHM-21).
 */
function customTokenValues(scheme: Scheme, colorTable: Readonly<Record<Role, string>>, selectionHex: string): Record<string, string> {
  const tokenValues = {
    ...Object.fromEntries(ROLES.map((role) => [ROLE_TO_HERDR_TOKEN[role], colorTable[role]])),
    ...structuralTokenValues(colorTable.ground, colorTable.body, selectionHex),
    ...extraAccentTokenValues(scheme),
  };
  assertOnlyAcceptedHerdrTokens(tokenValues);
  return tokenValues;
}

/** Upserts every [theme.custom] token Chameleon owns — see customTokenValues. */
function upsertCustomBlock(
  text: string,
  eol: string,
  scheme: Scheme,
  colorTable: Readonly<Record<Role, string>>,
  selectionHex: string,
): string {
  return upsertMarkedTokens(text, eol, "theme.custom", customTokenValues(scheme, colorTable, selectionHex));
}

/**
 * Upserts [ui]'s own `accent` — the key Herdr's borders and sidebar actually
 * read (see UI_ACCENT_KEY) — to `accentHex`. See upsertMarkedTokens.
 */
function upsertUiAccent(text: string, eol: string, accentHex: string): string {
  return upsertMarkedTokens(text, eol, "ui", { [UI_ACCENT_KEY]: accentHex });
}

/**
 * Backs up config.toml, then sets [theme].name to a real Herdr built-in for
 * `slug`, upserts every [theme.custom] token Chameleon owns (see
 * customTokenValues) under Herdr's own token names, and upserts [ui]'s own
 * `accent` to match — accent is the only colour key under [ui]; see CHM-23.
 * Every other [ui] setting, its comments included, is left untouched.
 *
 * The selection highlight — and, on the rare pack where ground and body
 * leave no room for a visible one, body itself — is resolved once here via
 * resolveSelectionAndBody (CHM-30), the exact pipeline buildThemePack runs
 * at build time, so a pack's live apply can never disagree with its own
 * shipped payload.
 */
function applyHerdrScheme(configPath: string | undefined, scheme: Scheme, slug: string): void {
  const resolvedConfigPath = requireConfigPath(configPath);
  if (!existsSync(resolvedConfigPath)) {
    throw new Error(`no Herdr config found at ${resolvedConfigPath}`);
  }

  copyFileSync(resolvedConfigPath, backupPathFor(resolvedConfigPath));

  const originalText = readFileSync(resolvedConfigPath, "utf8");
  const eol = detectLineEnding(originalText);
  const resolvedRoleHexes = resolveRoleHexes(scheme);
  const { selection, body } = resolveSelectionAndBody(scheme.selectionBackground, resolvedRoleHexes.ground, resolvedRoleHexes.body);
  const colorTable = { ...resolvedRoleHexes, body: body.hex };
  const themeName = herdrThemeNameFor(slug, colorTable.ground);

  const withName = upsertThemeName(originalText, eol, themeName);
  const withCustom = upsertCustomBlock(withName, eol, scheme, colorTable, selection.hex);
  const withUiAccent = upsertUiAccent(withCustom, eol, colorTable.accent);

  writeFileSync(resolvedConfigPath, withUiAccent, "utf8");
}

const HerdrCliErrorSchema = z.object({ code: z.string(), message: z.string().optional() }).catchall(z.unknown());

type HerdrCliError = z.infer<typeof HerdrCliErrorSchema>;

/**
 * Herdr's own CLI prints a JSON object on stderr when a command fails — for
 * example `{"code":"server_not_running"}` when there is no running server
 * left to reach over the socket. Extracted so a failed reload can surface
 * Herdr's own reason instead of a generic "it didn't work".
 */
function parseHerdrCliError(stderr: string): HerdrCliError | undefined {
  const jsonMatch = /\{[\s\S]*\}/.exec(stderr);
  if (!jsonMatch) return undefined;
  try {
    const parsed: unknown = JSON.parse(jsonMatch[0]);
    const validated = HerdrCliErrorSchema.safeParse(parsed);
    return validated.success ? validated.data : undefined;
  } catch {
    return undefined;
  }
}

/** Herdr's own CLI error code for "no server listening on the control socket" — the one reload failure CHM-45 treats as informational rather than broken, since it means there is nothing running to tell, not that Herdr rejected anything. See reloadHerdr. */
const SERVER_NOT_RUNNING_CODE = "server_not_running";

function describeReloadFailure(result: SpawnSyncReturns<string>, herdrError: HerdrCliError | undefined): string {
  if (result.error) {
    return `could not run "${HERDR_BINARY_NAME} ${RELOAD_CONFIG_ARGS.join(" ")}": ${result.error.message}`;
  }

  if (herdrError) {
    const detail = herdrError.message ? `: ${herdrError.message}` : "";
    return `herdr reported "${herdrError.code}"${detail}`;
  }

  return `"${HERDR_BINARY_NAME} ${RELOAD_CONFIG_ARGS.join(" ")}" exited with status ${String(result.status)}`;
}

const HerdrReloadResultSchema = z.object({
  result: z.object({ status: z.string(), diagnostics: z.array(z.string()).default([]) }).catchall(z.unknown()),
});

type HerdrReloadResult = z.infer<typeof HerdrReloadResultSchema>;

/** Herdr's own word, inside `reloadResult`, for whether the new config actually took effect — never the process exit code, see reloadHerdr. */
const RELOAD_APPLIED_STATUS = "applied";

/**
 * Herdr's own CLI prints this JSON object on stdout after every
 * `reload-config` call, success or failure alike — `result.status` is
 * Herdr's own word for whether the new config was actually applied, and
 * `result.diagnostics` names the reason when it was not, e.g. a config.toml
 * that failed to parse. Extracted so a failure reported this way can surface
 * Herdr's own diagnostics instead of a generic "it didn't work".
 */
function parseHerdrReloadResult(stdout: string): HerdrReloadResult | undefined {
  const jsonMatch = /\{[\s\S]*\}/.exec(stdout);
  if (!jsonMatch) return undefined;
  try {
    const parsed: unknown = JSON.parse(jsonMatch[0]);
    const validated = HerdrReloadResultSchema.safeParse(parsed);
    return validated.success ? validated.data : undefined;
  } catch {
    return undefined;
  }
}

/** Herdr's own diagnostics for a reload whose `status` was not "applied", verbatim — Herdr's own message names the file, the line and the problem better than anything Chameleon could synthesise. */
function describeReloadDiagnostics(reloadResult: HerdrReloadResult): string {
  const { status, diagnostics } = reloadResult.result;
  if (diagnostics.length === 0) return `herdr reported status "${status}"`;
  return diagnostics.join("\n");
}

/**
 * Reloads every pane from the config.toml already on disk — a call over
 * Herdr's own control socket, not a relaunch, which is what makes this safe
 * to run from inside a Herdr-managed pane: launching a *new* `herdr` from
 * inside one is exactly what Herdr's own CLI refuses to do, and
 * `server reload-config` is never that. It inherits the calling process's
 * environment — HERDR_ENV included — the same as any other spawned process;
 * nothing here needs to special-case it.
 *
 * A failed reload shows up three different ways, and all three must be
 * checked: `result.error` when the binary could not even be started, a
 * non-zero `result.status` when it ran and Herdr's own CLI reported failure
 * over stderr, and, since CHM-22, a zero exit status whose stdout JSON
 * payload itself says `"status":"failed"`, which is exactly what Herdr
 * returns for a config.toml it refused to parse: the process succeeded at
 * making the call, and Herdr succeeded at rejecting the config. Checking
 * only the exit code would call that last case a success and claim every
 * pane repainted when Herdr silently kept the previous config.
 *
 * One non-zero-status case is not a failure at all (CHM-45): `server_not_running`,
 * a stale environment pointed at a server that is no longer listening, or
 * simply no Herdr running right now. `apply` has already written a correct
 * config.toml by the time this runs — Herdr will read it the next time it
 * starts — so this reports it back as a detail, the same way
 * applyOhMyPoshScheme's profile-creation notice reports something worth
 * telling the user without failing the apply, rather than throwing and
 * turning a config that landed correctly into a reported failure.
 */
function reloadHerdr(): string | undefined {
  const result = spawnSync(HERDR_BINARY_NAME, [...RELOAD_CONFIG_ARGS], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    const herdrError = result.error ? undefined : parseHerdrCliError(result.stderr);
    if (herdrError?.code === SERVER_NOT_RUNNING_CODE) return "Herdr is not running — nothing to reload";
    throw new Error(`Herdr did not reload: ${describeReloadFailure(result, herdrError)}`);
  }

  const reloadResult = parseHerdrReloadResult(result.stdout);
  if (reloadResult && reloadResult.result.status !== RELOAD_APPLIED_STATUS) {
    throw new Error(`Herdr did not reload: ${describeReloadDiagnostics(reloadResult)}`);
  }
}

/**
 * Builds the Herdr adapter. `configPath` defaults to the real config.toml
 * location and is only ever overridden by tests, which point it at a
 * fixture copy so nothing here touches a real config.
 */
export function createHerdrAdapter(configPath: string | undefined = defaultConfigPath()): HerdrAdapter {
  return {
    detect: () => detectHerdr(configPath),
    read: () => readHerdrConfig(requireConfigPath(configPath)),
    apply: (scheme, slug) => applyHerdrScheme(configPath, scheme, slug),
    reload: () => reloadHerdr(),
  };
}

/**
 * Restores config.toml from the backup written by the most recent `apply`.
 * Not part of the adapter interface — undo is a user command, not a step in
 * the theming pipeline — but it lives beside the adapter because the backup
 * file's location and format are this file's business.
 */
export function undoHerdr(configPath: string | undefined = defaultConfigPath()): void {
  const resolvedConfigPath = requireConfigPath(configPath);
  const backupPath = backupPathFor(resolvedConfigPath);
  if (!existsSync(backupPath)) {
    throw new Error(`no backup found at ${backupPath} — nothing to undo`);
  }
  copyFileSync(backupPath, resolvedConfigPath);
}
