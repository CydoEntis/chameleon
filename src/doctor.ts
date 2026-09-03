/**
 * `ch doctor`'s own logic: what is installed, what is missing, and which
 * gaps Chameleon can offer to close. Kept out of index.ts because it pulls
 * in every adapter at once to build one report — a different shape of
 * function than the re-exports index.ts otherwise carries — and out of
 * cli.ts because none of it is argument parsing or terminal output.
 */

import { createHerdrAdapter, type HerdrAdapter } from "./adapters/herdr.js";
import {
  evaluateNerdFontStatus,
  listInstalledFontFamilyNames,
  NERD_FONT_INSTALL_ARGS,
  OH_MY_POSH_BINARY_NAME,
  type NerdFontStatus,
} from "./adapters/nerd-font.js";
import {
  createOhMyPoshAdapter,
  OH_MY_POSH_WINGET_INSTALL_ARGS,
  WINGET_BINARY_NAME,
  type OhMyPoshAdapter,
} from "./adapters/oh-my-posh.js";
import {
  createWindowsTerminalAdapter,
  selectedFontFace,
  type WindowsTerminalAdapter,
} from "./adapters/windows-terminal.js";
import type { Target } from "./index.js";

export interface TargetDoctorStatus {
  readonly target: Target;
  readonly isInstalled: boolean;
}

export interface DoctorReport {
  readonly targets: readonly TargetDoctorStatus[];
  readonly nerdFont: NerdFontStatus;
}

/**
 * The font family name Windows Terminal is actually pointed at, or
 * undefined when there is nothing to read one out of — either no Windows
 * Terminal at all, or a settings.json a user has hand-edited into something
 * this adapter cannot parse. Either way `ch doctor` must keep going with
 * the rest of its report rather than crash on the one check it exists to
 * run; see CLAUDE.md, "Never hard-fails because something is missing."
 */
function readSelectedFontFace(windowsTerminal: WindowsTerminalAdapter, isWindowsTerminalInstalled: boolean): string | undefined {
  if (!isWindowsTerminalInstalled) return undefined;
  try {
    return selectedFontFace(windowsTerminal.read());
  } catch {
    return undefined;
  }
}

/**
 * Detects every theming target plus the Nerd Font this ticket exists to
 * check, and never throws on a gap — a target or font that is missing is a
 * row in the report, not a failure. See CLAUDE.md, "Never hard-fails
 * because something is missing." Every adapter defaults to the real
 * machine; tests override each with a fixture-backed one instead of an
 * environment variable, the same dependency-injection shape every adapter
 * constructor already uses.
 */
export function buildDoctorReport(
  windowsTerminal: WindowsTerminalAdapter = createWindowsTerminalAdapter(),
  ohMyPosh: OhMyPoshAdapter = createOhMyPoshAdapter(),
  herdr: HerdrAdapter = createHerdrAdapter(),
  listInstalledFontFamilyNamesFn: () => string[] = listInstalledFontFamilyNames,
): DoctorReport {
  const isWindowsTerminalInstalled = windowsTerminal.detect();
  const targets: TargetDoctorStatus[] = [
    { target: "windows-terminal", isInstalled: isWindowsTerminalInstalled },
    { target: "oh-my-posh", isInstalled: ohMyPosh.detect() },
    { target: "herdr", isInstalled: herdr.detect() },
  ];

  const nerdFont = evaluateNerdFontStatus(listInstalledFontFamilyNamesFn(), readSelectedFontFace(windowsTerminal, isWindowsTerminalInstalled));

  return { targets, nerdFont };
}

export type DoctorActionKind = "install-oh-my-posh" | "install-nerd-font" | "select-nerd-font";

export interface DoctorAction {
  readonly kind: DoctorActionKind;
  readonly description: string;
  /** The literal shell command this action runs — undefined for `select-nerd-font`, which edits settings.json directly rather than shelling out. See CLAUDE.md, "Chameleon owns the profile line, because that is a config edit." */
  readonly commandLine: string | undefined;
  /** The Nerd Font family name to select — set only for `select-nerd-font`. */
  readonly fontFamilyName: string | undefined;
}

/**
 * The gaps `ch doctor` can offer to close right now, in the order they
 * should be printed — never Herdr, which this ticket keeps detect-only, see
 * CLAUDE.md, "Installing Herdr — detect only, never install." Returned as
 * plain data, not closures, so the CLI can print every command before
 * running any of them and so a test can assert on what would happen without
 * mocking a spawned process.
 */
export function describeDoctorActions(report: DoctorReport): DoctorAction[] {
  const actions: DoctorAction[] = [];

  const ohMyPoshStatus = report.targets.find((status) => status.target === "oh-my-posh");
  if (ohMyPoshStatus && !ohMyPoshStatus.isInstalled) {
    actions.push({
      kind: "install-oh-my-posh",
      description: "Install Oh My Posh",
      commandLine: [WINGET_BINARY_NAME, ...OH_MY_POSH_WINGET_INSTALL_ARGS].join(" "),
      fontFamilyName: undefined,
    });
  }

  if (!report.nerdFont.isInstalled) {
    actions.push({
      kind: "install-nerd-font",
      description: "Install a Nerd Font (Meslo)",
      commandLine: [OH_MY_POSH_BINARY_NAME, ...NERD_FONT_INSTALL_ARGS].join(" "),
      fontFamilyName: undefined,
    });
  } else if (!report.nerdFont.isSelected) {
    // isInstalled guarantees at least one entry here — see evaluateNerdFontStatus — but
    // destructuring rather than asserting keeps this honest under noUncheckedIndexedAccess.
    const [fontFamilyName] = report.nerdFont.installedNerdFontFamilyNames;
    if (fontFamilyName) {
      actions.push({
        kind: "select-nerd-font",
        description: `Set Windows Terminal's profiles.defaults.fontFace to "${fontFamilyName}"`,
        commandLine: undefined,
        fontFamilyName,
      });
    }
  }

  return actions;
}
