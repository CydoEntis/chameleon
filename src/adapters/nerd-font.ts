import { spawnSync } from "node:child_process";
import { describeSpawnFailure } from "./spawn-result.js";

/**
 * Family names a Nerd Font registers under. Every glyph-patched build the
 * nerd-fonts project ships is suffixed "Nerd Font" (e.g. "CaskaydiaCove
 * Nerd Font"), except the one Oh My Posh's own docs recommend and this
 * adapter installs — `oh-my-posh font install meslo` — which keeps the
 * older nerd-fonts naming, "MesloLGS NF". Matching on the family name
 * itself, not a fixed list, is what lets `ch doctor` recognise a Nerd Font
 * the user already had installed before ever running `ch`.
 */
const NERD_FONT_FAMILY_NAME_PATTERN = /nerd font|(?:^|\s)nf$/i;

/** Whether `fontFamilyName` reads as a Nerd Font build — see NERD_FONT_FAMILY_NAME_PATTERN for what counts. */
export function isNerdFontFamilyName(fontFamilyName: string): boolean {
  return NERD_FONT_FAMILY_NAME_PATTERN.test(fontFamilyName.trim());
}

const REG_QUERY_BINARY_NAME = "reg";

/**
 * Both locations Windows registers an installed font's family name under.
 * `oh-my-posh font install --headless` writes to the per-user key; an
 * admin-run installer writes to the machine-wide one. Either makes a font
 * available to Windows Terminal's font picker, so both are checked.
 */
const FONT_REGISTRY_KEYS = [
  "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",
  "HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",
] as const;

/** One `reg query` value line, e.g. `    MesloLGS NF (TrueType)    REG_SZ    MesloLGSNFRegular.ttf` — captures the family name before its type suffix. */
const REG_FONT_VALUE_LINE_REGEX = /^\s{4}(.+?)\s+REG_SZ\s+.+$/;

/** Strips the "(TrueType)" / "(OpenType)" suffix `reg query` appends to a font's registered value name, leaving the family name Windows Terminal's own fontFace setting expects. */
function stripFontTypeSuffix(valueName: string): string {
  return valueName.replace(/\s*\((TrueType|OpenType)\)\s*$/i, "").trim();
}

/** Every font family name one Fonts registry key's own `reg query` stdout lists. */
export function parseFontFamilyNamesFromRegQueryOutput(regQueryStdout: string): string[] {
  return regQueryStdout
    .split(/\r?\n/)
    .map((line) => REG_FONT_VALUE_LINE_REGEX.exec(line)?.[1])
    .filter((valueName): valueName is string => valueName !== undefined)
    .map(stripFontTypeSuffix);
}

/**
 * Every font family name currently installed for this user or system-wide.
 * A registry key that does not exist yet — a fresh machine with nothing
 * installed there — is reported as no fonts rather than a failure, which is
 * what keeps `ch doctor` from hard-failing on the very check it exists to
 * run; see CLAUDE.md, "Never hard-fails because something is missing."
 */
export function listInstalledFontFamilyNames(): string[] {
  return FONT_REGISTRY_KEYS.flatMap((registryKey) => {
    const result = spawnSync(REG_QUERY_BINARY_NAME, [registryKey], { encoding: "utf8" });
    return result.status === 0 ? parseFontFamilyNamesFromRegQueryOutput(result.stdout) : [];
  });
}

export interface NerdFontStatus {
  readonly installedNerdFontFamilyNames: readonly string[];
  readonly isInstalled: boolean;
  readonly selectedFontFace: string | undefined;
  readonly isSelected: boolean;
}

/**
 * Combines what is installed with what Windows Terminal's own
 * profiles.defaults.fontFace names, so a Nerd Font that is on the machine
 * but never picked in the terminal profile — the bug this ticket exists to
 * catch, see CLAUDE.md, "checking only one is the common bug" — is told
 * apart from one that is missing outright.
 */
export function evaluateNerdFontStatus(installedFontFamilyNames: readonly string[], selectedFontFace: string | undefined): NerdFontStatus {
  const installedNerdFontFamilyNames = installedFontFamilyNames.filter(isNerdFontFamilyName);
  const isSelected = selectedFontFace !== undefined && isNerdFontFamilyName(selectedFontFace);
  return {
    installedNerdFontFamilyNames,
    isInstalled: installedNerdFontFamilyNames.length > 0,
    selectedFontFace,
    isSelected,
  };
}

/** The binary and subcommand Oh My Posh's own docs give for a headless font install. `ch doctor` is the only caller, and only after the user has confirmed. */
export const OH_MY_POSH_BINARY_NAME = "oh-my-posh";
export const NERD_FONT_INSTALL_ARGS = ["font", "install", "meslo", "--headless"] as const;

/**
 * Installs the Meslo Nerd Font via Oh My Posh's own font installer — never
 * a hand-rolled font patcher, see CLAUDE.md, "Delegate installs... Do not
 * reimplement installers." `--headless` skips the interactive family picker
 * Oh My Posh otherwise shows, since this only ever runs from `ch doctor`
 * after the user has already picked "yes".
 */
export function installNerdFont(): void {
  const result = spawnSync(OH_MY_POSH_BINARY_NAME, [...NERD_FONT_INSTALL_ARGS], { stdio: "inherit" });
  if (result.error || result.status !== 0) {
    throw new Error(`could not install a Nerd Font: ${describeSpawnFailure(OH_MY_POSH_BINARY_NAME, NERD_FONT_INSTALL_ARGS, result)}`);
  }
}
