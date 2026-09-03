import { spawnSync } from "node:child_process";

/**
 * Windows registry key under which every font installed for the current
 * user is listed as a value name — read via `reg query`, the same mechanism
 * Windows' own Fonts control panel populates from. HKCU holds per-user
 * installs ("install for me only", the common case for a Nerd Font someone
 * installed themselves); a machine-wide install lives under HKLM instead,
 * but a font installed for the current user alone is already enough for it
 * to render in that user's own terminal, which is all `ch doctor` cares
 * about.
 */
const USER_FONTS_REGISTRY_KEY = "HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts";

/**
 * A line of `reg query` output naming one installed font, e.g.
 * `    CaskaydiaCove NF (TrueType)    REG_SZ    CaskaydiaCoveNerdFont-Regular.ttf`.
 * Only the value-name column — the font's family name, format suffix and
 * all — is captured; the data column is the file name, which this adapter
 * never needs.
 */
const REGISTRY_VALUE_LINE_PATTERN = /^ {4}(.+?)\s+REG_(?:SZ|EXPAND_SZ)\s+.+$/;

/** The "(TrueType)" / "(OpenType)" suffix `reg query` appends to a font's value name — never part of its family name. */
const FONT_FORMAT_SUFFIX_PATTERN = /\s*\((TrueType|OpenType)\)$/;

/**
 * A font family reads as a Nerd Font by its own patched name, not by any
 * registry flag — the Nerd Fonts patcher appends "Nerd Font", "NF", "NFM" or
 * "NFP" to whatever family it patches (e.g. "CaskaydiaCove NF",
 * "FiraCode Nerd Font Mono"). There is no more authoritative signal
 * available from the registry alone.
 */
const NERD_FONT_FAMILY_NAME_PATTERN = /nerd font|\bnf[mp]?$/i;

/** oh-my-posh's own font installer, and the font it recommends when nothing else has been chosen. See CLAUDE.md, "Delegating installs to winget / oh-my-posh font install rather than reimplementing an installer." */
const OH_MY_POSH_BINARY_NAME = "oh-my-posh";
const OH_MY_POSH_FONT_SUBCOMMAND = ["font", "install"] as const;
const DEFAULT_NERD_FONT_NAME = "CascadiaCode";

/**
 * Whether `fontFamilyName` itself reads as a Nerd Font by its patched name.
 * Exported so `ch doctor` can tell "some font is selected" apart from "the
 * selected font is a Nerd Font" — see CLAUDE.md, "The distinction between a
 * font being installed and being selected."
 */
export function isNerdFontFamilyName(fontFamilyName: string): boolean {
  return NERD_FONT_FAMILY_NAME_PATTERN.test(fontFamilyName);
}

/**
 * Every font family name registered for the current user. A `reg query`
 * that fails outright — the key does not exist, or `reg` itself is missing,
 * vanishingly unlikely on Windows but not this adapter's problem to raise —
 * is treated as no fonts found rather than an error, so a doctor run never
 * hard-fails on this check.
 */
function installedFontFamilyNames(): string[] {
  const result = spawnSync("reg", ["query", USER_FONTS_REGISTRY_KEY], { encoding: "utf8" });
  if (result.error || result.status !== 0) return [];

  return result.stdout
    .split(/\r?\n/)
    .map((line) => REGISTRY_VALUE_LINE_PATTERN.exec(line)?.[1])
    .filter((fontFamilyName): fontFamilyName is string => fontFamilyName !== undefined)
    .map((fontFamilyName) => fontFamilyName.replace(FONT_FORMAT_SUFFIX_PATTERN, ""));
}

/**
 * Whether any Nerd Font is installed for the current user — regardless of
 * which one, and regardless of whether any target has actually selected it.
 * Installed and selected are different questions; see selectedFontFace in
 * windows-terminal.ts for the second one, and CLAUDE.md, "The distinction
 * between a font being installed and being selected — the whole point of
 * the ticket."
 */
export function detectNerdFontInstalled(): boolean {
  return installedFontFamilyNames().some(isNerdFontFamilyName);
}

/** The one-line command `ch doctor` offers to install a Nerd Font, delegating to oh-my-posh's own installer rather than reimplementing one. */
export function nerdFontInstallCommand(fontName: string = DEFAULT_NERD_FONT_NAME): string {
  return `${OH_MY_POSH_BINARY_NAME} ${OH_MY_POSH_FONT_SUBCOMMAND.join(" ")} ${fontName}`;
}
