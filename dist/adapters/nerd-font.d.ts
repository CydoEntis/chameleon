/** Whether `fontFamilyName` reads as a Nerd Font build — see NERD_FONT_FAMILY_NAME_PATTERN for what counts. */
export declare function isNerdFontFamilyName(fontFamilyName: string): boolean;
/** Every font family name one Fonts registry key's own `reg query` stdout lists. */
export declare function parseFontFamilyNamesFromRegQueryOutput(regQueryStdout: string): string[];
/**
 * Every font family name currently installed for this user or system-wide.
 * A registry key that does not exist yet — a fresh machine with nothing
 * installed there — is reported as no fonts rather than a failure, which is
 * what keeps `ch doctor` from hard-failing on the very check it exists to
 * run; see CLAUDE.md, "Never hard-fails because something is missing."
 */
export declare function listInstalledFontFamilyNames(): string[];
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
export declare function evaluateNerdFontStatus(installedFontFamilyNames: readonly string[], selectedFontFace: string | undefined): NerdFontStatus;
/** The binary and subcommand Oh My Posh's own docs give for a headless font install. `ch doctor` is the only caller, and only after the user has confirmed. */
export declare const OH_MY_POSH_BINARY_NAME = "oh-my-posh";
export declare const NERD_FONT_INSTALL_ARGS: readonly ["font", "install", "meslo", "--headless"];
/**
 * Installs the Meslo Nerd Font via Oh My Posh's own font installer — never
 * a hand-rolled font patcher, see CLAUDE.md, "Delegate installs... Do not
 * reimplement installers." `--headless` skips the interactive family picker
 * Oh My Posh otherwise shows, since this only ever runs from `ch doctor`
 * after the user has already picked "yes".
 */
export declare function installNerdFont(): void;
