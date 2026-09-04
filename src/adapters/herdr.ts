import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ROLES, type Role } from "../constants.js";
import { toPalette, type Appearance } from "../palette/palette.js";
import { resolveRoleHexes } from "../palette/repair.js";
import type { Scheme } from "../palette/scheme.js";
import { detectLineEnding } from "./marked-json-edit.js";

/** Suffix for the pre-apply copy of config.toml that `undoHerdr` restores from. */
const BACKUP_FILE_SUFFIX = ".chameleon-backup";

/**
 * Every edit this adapter makes inside [theme.custom] is wrapped in this
 * pair, so a rerun can find and replace its own entries without disturbing
 * any override the user wrote there themselves. TOML's comment syntax is
 * `#`, same as the marker this project already uses for the PowerShell
 * profile — see oh-my-posh.ts.
 */
const MARKER_BEGIN = "# ch:begin";
const MARKER_END = "# ch:end";

/** The binary and subcommand Herdr's own docs give for a live reload — a call over Herdr's control socket, never a relaunch. See reloadHerdr. */
const HERDR_BINARY_NAME = "herdr";
const RELOAD_CONFIG_ARGS = ["server", "reload-config"] as const;

/**
 * The slice of Herdr's config.toml this adapter actually depends on.
 * Everything else in a real config.toml ([ui], status-bar settings, …) is
 * never parsed and never touched — this schema exists only to describe the
 * shape this adapter reads back out, never to police the rest of a user's
 * config.
 */
const HerdrConfigSchema = z.object({
  theme: z.object({
    name: z.string().optional(),
    custom: z.record(z.string(), z.string()),
  }),
});

export type HerdrConfig = z.infer<typeof HerdrConfigSchema>;

export interface HerdrAdapter {
  detect(): boolean;
  read(): HerdrConfig;
  apply(scheme: Scheme, slug: string): void;
  reload(): void;
}

/**
 * Chameleon pack slug → Herdr's own built-in theme slug, for the packs whose
 * upstream family already ships as one — see Herdr's own theme picker for
 * the authoritative list. "Catppuccin Mocha" (the Windows Terminal scheme's
 * display name Chameleon used to write verbatim) was never one of these:
 * Herdr's built-in is named `catppuccin`, and it silently ignores anything
 * else — see CHM-21.
 *
 * A slug absent from this table — github, ayu, night-owl, everforest,
 * monokai, and any user-supplied pack — has no Herdr built-in at all. Its
 * `name` falls back to the nearest built-in by appearance (see
 * HERDR_DARK_FALLBACK_THEME/HERDR_LIGHT_FALLBACK_THEME below); its own
 * colours still reach Herdr through [theme.custom] regardless, via
 * buildCustomBlockLines, so the theme visibly changes either way.
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
  "rose-pine-dark": "rose-pine",
};

/**
 * The built-in Herdr falls back to when a pack's slug has no family match —
 * "terminal" is Herdr's own generic, non-family dark theme, the closest
 * thing its picker has to a neutral default. There is no equivalent neutral
 * light built-in, so "one-light" — the least family-branded of Herdr's five
 * light built-ins — stands in for one. Neither is a colour match; the
 * pack's actual colours still land in [theme.custom] regardless (see
 * herdrThemeNameFor's callers), which is what makes an unmatched pack's
 * apply visibly change Herdr at all rather than merely naming a real theme.
 */
const HERDR_DARK_FALLBACK_THEME = "terminal";
const HERDR_LIGHT_FALLBACK_THEME = "one-light";

/** The Herdr theme name to write for `slug` — its own built-in when one exists, otherwise the nearest fallback for `appearance`. Always a name real Herdr accepts. */
function herdrThemeNameFor(slug: string, appearance: Appearance): string {
  return PACK_SLUG_TO_HERDR_THEME[slug] ?? (appearance === "dark" ? HERDR_DARK_FALLBACK_THEME : HERDR_LIGHT_FALLBACK_THEME);
}

/**
 * Chameleon's own six roles → the real [theme.custom] tokens Herdr's own
 * default config documents. Herdr does not recognise `ground`, `body`,
 * `muted`, `success` or `error` — those were invented, and Herdr silently
 * dropped all five (see CHM-21). Only `accent` was ever a real token.
 *
 * Ideally sourced from `herdr --default-config` rather than hand-maintained,
 * per the ticket, but that requires a live Herdr install — not something
 * this adapter, or its tests, can depend on. Herdr's own docs list these as
 * the tokens a config's [theme.custom] honours, alongside ones Chameleon has
 * no role for (active_row_bg, selection_bg, panel_bg, surface_dim).
 */
const ROLE_TO_HERDR_TOKEN: Readonly<Record<Role, string>> = {
  ground: "sidebar_bg",
  body: "text",
  accent: "accent",
  muted: "subtext0",
  success: "green",
  error: "red",
};

/** Where Herdr keeps config.toml, under the user's roaming app data. */
function defaultConfigPath(): string | undefined {
  const appData = process.env["APPDATA"];
  if (!appData) return undefined;
  return path.join(appData, "herdr", "config.toml");
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
// exactly two tables ([theme] and [theme.custom]), both flat string maps,
// so a hand-rolled line scan is enough to find and edit them without
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

  const shape = {
    theme: {
      name: extractStringValue(themeBodyLines, "name"),
      custom: extractStringKeyValues(customBodyLines),
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

function buildCustomBlockLines(roles: readonly Role[], colorTable: Readonly<Record<Role, string>>): string[] {
  return roles.map((role) => `${ROLE_TO_HERDR_TOKEN[role]} = ${JSON.stringify(colorTable[role])}`);
}

/** `key = "…"` capturing everything before and after the quoted value, so the value can be swapped without disturbing indentation, key spacing or a trailing comment. */
const STRING_KEY_VALUE_REPLACE_REGEX = /^(\s*[A-Za-z0-9_.-]+\s*=\s*)"(?:[^"\\]|\\.)*"(\s*(?:#.*)?)$/;

/** `line`, with its quoted value swapped for `newValue` — everything else on the line, trailing comment included, is left exactly as written. */
function replaceStringValue(line: string, newValue: string): string {
  return line.replace(STRING_KEY_VALUE_REPLACE_REGEX, (_match, prefix: string, suffix: string) => `${prefix}${JSON.stringify(newValue)}${suffix}`);
}

/**
 * Rewrites, in place, the value of any line among `lines` whose key is one of
 * Herdr's own tokens for `colorTable`'s roles — the line itself, and any
 * comment on it or above it, never moves. Returns which Herdr tokens were
 * found this way, so the caller can leave them out of the marked block it is
 * about to (re)write instead of writing a second copy of the same key.
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
  colorTable: Readonly<Record<Role, string>>,
): { updatedLines: string[]; ownedTokens: Set<string> } {
  const ownedTokens = new Set<string>();
  const updatedLines = lines.map((line) => {
    const key = STRING_KEY_VALUE_REGEX.exec(line)?.[1];
    const role = key === undefined ? undefined : ROLES.find((candidateRole) => ROLE_TO_HERDR_TOKEN[candidateRole] === key);
    if (!role || key === undefined) return line;
    ownedTokens.add(key);
    return replaceStringValue(line, colorTable[role]);
  });
  return { updatedLines, ownedTokens };
}

/** The roles among `ROLES` whose Herdr token is not already claimed by a plain line the user wrote — i.e. the roles the marked block still needs to carry itself. */
function rolesNotOwned(ownedTokens: ReadonlySet<string>): Role[] {
  return ROLES.filter((role) => !ownedTokens.has(ROLE_TO_HERDR_TOKEN[role]));
}

/**
 * Upserts Chameleon's own colour tokens into [theme.custom], scoped between
 * ch:begin/ch:end. A user's own overrides in the same table — outside the
 * marker — are never touched, so a config that already carries hand-picked
 * [theme.custom] entries keeps them across every apply. When one of those
 * outside-the-marker lines already sets a key Chameleon itself owns (`text`,
 * `subtext0`, …), that line is updated in place instead — see
 * takeOverExistingTokenLines — so the table never ends up with two of it.
 */
function upsertCustomBlock(text: string, eol: string, colorTable: Readonly<Record<Role, string>>): string {
  const lines = text.split(eol);
  const customTable = findTable(lines, "theme.custom");

  if (!customTable) {
    const markedLines = [MARKER_BEGIN, ...buildCustomBlockLines(ROLES, colorTable), MARKER_END];
    return appendTable(text, eol, "theme.custom", markedLines);
  }

  const bodyLines = lines.slice(customTable.bodyStartLineIndex, customTable.bodyEndLineIndex);
  const beginIndex = bodyLines.findIndex((line) => line.trim() === MARKER_BEGIN);

  if (beginIndex === -1) {
    const { updatedLines, ownedTokens } = takeOverExistingTokenLines(bodyLines, colorTable);
    const markedLines = [MARKER_BEGIN, ...buildCustomBlockLines(rolesNotOwned(ownedTokens), colorTable), MARKER_END];
    return spliceTableBody(lines, customTable, [...markedLines, ...updatedLines], eol);
  }

  const endIndex = bodyLines.findIndex((line, index) => index > beginIndex && line.trim() === MARKER_END);
  if (endIndex === -1) {
    throw new Error(
      "config.toml has a ch:begin marker in [theme.custom] with no matching ch:end — refusing to guess where Chameleon's block ends",
    );
  }

  // Only the lines outside Chameleon's own current marker are candidates for
  // "the user already has this key" — the marker's own lines are about to be
  // replaced wholesale regardless, so scanning them too would just make this
  // rewrite think it "found" its own previous values.
  const before = takeOverExistingTokenLines(bodyLines.slice(0, beginIndex), colorTable);
  const after = takeOverExistingTokenLines(bodyLines.slice(endIndex + 1), colorTable);
  const ownedTokens = new Set([...before.ownedTokens, ...after.ownedTokens]);
  const markedLines = [MARKER_BEGIN, ...buildCustomBlockLines(rolesNotOwned(ownedTokens), colorTable), MARKER_END];

  const updatedBodyLines = [...before.updatedLines, ...markedLines, ...after.updatedLines];
  return spliceTableBody(lines, customTable, updatedBodyLines, eol);
}

/**
 * Backs up config.toml, then sets [theme].name to a real Herdr built-in for
 * `slug` and upserts the [theme.custom] colour tokens, under Herdr's own
 * token names, for `scheme`'s resolved roles — both edits leaving everything
 * else in the file, [ui] and its comments included, untouched.
 */
function applyHerdrScheme(configPath: string | undefined, scheme: Scheme, slug: string): void {
  const resolvedConfigPath = requireConfigPath(configPath);
  if (!existsSync(resolvedConfigPath)) {
    throw new Error(`no Herdr config found at ${resolvedConfigPath}`);
  }

  copyFileSync(resolvedConfigPath, backupPathFor(resolvedConfigPath));

  const originalText = readFileSync(resolvedConfigPath, "utf8");
  const eol = detectLineEnding(originalText);
  const colorTable = resolveRoleHexes(scheme);
  const themeName = herdrThemeNameFor(slug, toPalette(scheme).appearance);

  const withName = upsertThemeName(originalText, eol, themeName);
  const withCustom = upsertCustomBlock(withName, eol, colorTable);

  writeFileSync(resolvedConfigPath, withCustom, "utf8");
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

function describeReloadFailure(result: SpawnSyncReturns<string>): string {
  if (result.error) {
    return `could not run "${HERDR_BINARY_NAME} ${RELOAD_CONFIG_ARGS.join(" ")}": ${result.error.message}`;
  }

  const herdrError = parseHerdrCliError(result.stderr);
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
 * over stderr — most commonly `server_not_running`, a stale environment
 * pointed at a server that is no longer listening — and, since CHM-22, a
 * zero exit status whose stdout JSON payload itself says
 * `"status":"failed"`, which is exactly what Herdr returns for a
 * config.toml it refused to parse: the process succeeded at making the
 * call, and Herdr succeeded at rejecting the config. Checking only the exit
 * code would call that last case a success and claim every pane repainted
 * when Herdr silently kept the previous config.
 */
function reloadHerdr(): void {
  const result = spawnSync(HERDR_BINARY_NAME, [...RELOAD_CONFIG_ARGS], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(`Herdr did not reload: ${describeReloadFailure(result)}`);
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
