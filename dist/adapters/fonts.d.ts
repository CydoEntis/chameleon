/**
 * Whether `fontFamilyName` itself reads as a Nerd Font by its patched name.
 * Exported so `ch doctor` can tell "some font is selected" apart from "the
 * selected font is a Nerd Font" — see CLAUDE.md, "The distinction between a
 * font being installed and being selected."
 */
export declare function isNerdFontFamilyName(fontFamilyName: string): boolean;
/**
 * Whether any Nerd Font is installed for the current user — regardless of
 * which one, and regardless of whether any target has actually selected it.
 * Installed and selected are different questions; see selectedFontFace in
 * windows-terminal.ts for the second one, and CLAUDE.md, "The distinction
 * between a font being installed and being selected — the whole point of
 * the ticket."
 */
export declare function detectNerdFontInstalled(): boolean;
/** The one-line command `ch doctor` offers to install a Nerd Font, delegating to oh-my-posh's own installer rather than reimplementing one. */
export declare function nerdFontInstallCommand(fontName?: string): string;
