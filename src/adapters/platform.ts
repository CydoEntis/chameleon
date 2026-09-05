import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * The single home for every OS- and shell-specific path and detection this
 * project needs. Before this file existed, LOCALAPPDATA/APPDATA/USERPROFILE
 * reads were scattered across state.ts, user-theme-packs.ts, herdr.ts,
 * oh-my-posh.ts and windows-terminal.ts, each one Windows-only and each one
 * throwing when its own env var was unset — which is every Linux machine.
 * See CHM-25.
 */

/** Chameleon's own state directory name, one level under the platform's data directory. */
const STATE_DIR_NAME = "chameleon";

export type Platform = "windows" | "linux" | "macos";

/**
 * Which of the three platforms `ch` is running under, from Node's own
 * `process.platform`. Takes that as an overridable argument, rather than
 * reading the global directly, so a test can exercise the non-host branch of
 * anything built on this without monkey-patching a Node global.
 */
export function currentPlatform(nodePlatform: NodeJS.Platform = process.platform): Platform {
  if (nodePlatform === "win32") return "windows";
  if (nodePlatform === "darwin") return "macos";
  return "linux";
}

export function isWindows(nodePlatform: NodeJS.Platform = process.platform): boolean {
  return currentPlatform(nodePlatform) === "windows";
}

/** The XDG Base Directory spec's data home, or its own documented fallback — `~/.local/share`. */
function xdgDataHome(): string {
  return process.env["XDG_DATA_HOME"] || path.join(homedir(), ".local", "share");
}

/** The XDG Base Directory spec's config home, or its own documented fallback — `~/.config`. */
function xdgConfigHome(): string {
  return process.env["XDG_CONFIG_HOME"] || path.join(homedir(), ".config");
}

/**
 * Chameleon's own state directory — the active-pack pointer, the Oh My Posh
 * pointer, and the user theme pack directory all live under this. Windows
 * keeps it under `%LOCALAPPDATA%`, matching every other per-user Windows app
 * data directory; everywhere else it follows the XDG Base Directory spec.
 */
export function stateDir(): string {
  if (isWindows()) {
    const localAppData = process.env["LOCALAPPDATA"];
    if (!localAppData) {
      throw new Error("LOCALAPPDATA is not set — cannot locate Chameleon's state directory");
    }
    return path.join(localAppData, STATE_DIR_NAME);
  }
  return path.join(xdgDataHome(), STATE_DIR_NAME);
}

/**
 * Where Herdr keeps config.toml. Windows keeps it under `%APPDATA%` — Herdr's
 * own choice, not Chameleon's — and undefined when that is not set, so
 * `detect()` can report "not found" cleanly rather than throwing. Everywhere
 * else Herdr follows the XDG Base Directory spec, which always resolves to
 * something (a bare `homedir()` fallback), so there is no equivalent "unset"
 * case to report.
 */
export function herdrConfigPath(): string | undefined {
  if (isWindows()) {
    const appData = process.env["APPDATA"];
    if (!appData) return undefined;
    return path.join(appData, "herdr", "config.toml");
  }
  return path.join(xdgConfigHome(), "herdr", "config.toml");
}

/**
 * Where Claude Code keeps settings.json — always under the user's home
 * directory, on every platform Claude Code ships for. Unlike Herdr or
 * Windows Terminal there is no OS-specific app-data directory to resolve and
 * no env var that can be missing, so this never returns undefined. See CHM-49.
 */
export function claudeCodeSettingsPath(): string {
  return path.join(homedir(), ".claude", "settings.json");
}

// --- Shell detection, for Oh My Posh's own live-reload hook -----------------
//
// Oh My Posh's live reload works by extending whichever shell is running
// with a hook that notices when Chameleon's pointer file changes — and that
// hook, and the file it is written into, are different for every shell. See
// adapters/oh-my-posh.ts.

export const SHELLS = ["pwsh", "cmd", "bash", "zsh"] as const;
export type Shell = (typeof SHELLS)[number];

/**
 * Best-effort detection of the shell `ch` is running inside. On Windows,
 * PowerShell (both editions) always exports `PSModulePath` into every
 * process it launches; cmd.exe never sets it, so its absence is what
 * distinguishes the two — there is no equivalent env var cmd.exe itself
 * guarantees. Everywhere else, `$SHELL` names the user's own login shell,
 * and only zsh is distinguished from the bash default: every POSIX shell
 * this project supports other than zsh is treated as bash.
 */
export function detectShell(nodePlatform: NodeJS.Platform = process.platform): Shell {
  if (currentPlatform(nodePlatform) === "windows") {
    return process.env["PSModulePath"] ? "pwsh" : "cmd";
  }
  const loginShellName = path.basename(process.env["SHELL"] ?? "");
  return loginShellName.includes("zsh") ? "zsh" : "bash";
}

/**
 * The interactive-startup file `shell`'s own live-reload hook belongs in —
 * read on every new shell, and, via the hook this file installs, rechecked
 * on every prompt render of one already open. cmd.exe has no such file of
 * its own; its hook is a Clink Lua script instead, so it is routed to
 * clinkScriptPath rather than a profile.
 *
 * `pwsh` covers both PowerShell editions, and the two read *different*
 * profile files under *different* folder names — see
 * choosePowerShellEdition and windowsDocumentsDir. Assuming either one, the
 * way this used to hardcode PowerShell 7's `Documents\PowerShell`, writes a
 * hook to a file the installed edition never loads — see CHM-39.
 */
export function ohMyPoshProfilePathFor(shell: Shell): string {
  if (shell === "cmd") return clinkScriptPath();
  if (shell === "bash") return path.join(homedir(), ".bashrc");
  if (shell === "zsh") return path.join(process.env["ZDOTDIR"] || homedir(), ".zshrc");

  const documentsDir = windowsDocumentsDir();
  // Never assume pwsh: Windows PowerShell ships on every Windows machine and
  // pwsh does not, so a tie (both or neither detected) falls back to the
  // edition guaranteed to exist rather than the exception.
  const edition = detectPowerShellEdition(documentsDir) ?? "windowsPowerShell";
  return powerShellProfilePathFor(documentsDir, edition);
}

// --- PowerShell edition and Documents-folder resolution, for CHM-39 --------
//
// Two path errors used to compound here: assuming PowerShell 7 (`pwsh`) on a
// machine that only has Windows PowerShell 5.1, and assuming `~/Documents`
// on a machine where Windows has redirected it (to OneDrive, among other
// places). Both are resolved below rather than assumed.

export type PowerShellEdition = "pwsh" | "windowsPowerShell";

/** The profile folder name each PowerShell edition reads from under Documents — `pwsh`'s own convention, distinct from Windows PowerShell's pre-existing one. */
function powerShellProfilePathFor(documentsDir: string, edition: PowerShellEdition): string {
  const profileFolderName = edition === "pwsh" ? "PowerShell" : "WindowsPowerShell";
  return path.join(documentsDir, profileFolderName, "Microsoft.PowerShell_profile.ps1");
}

/**
 * Which PowerShell edition `ch` should treat as the real one, given what is
 * actually installed and which of the two profiles already exists on disk.
 * Pure — so this decision is testable without spawning a real shell or
 * touching a real filesystem — see detectPowerShellEdition, which supplies
 * both real inputs.
 *
 * A machine with only one edition installed gets that one, never an
 * assumption. Where both are installed, the one whose profile file already
 * exists wins — that is the one this machine's own shell has actually been
 * loading. A tie between the two (both or neither profile present) falls
 * back to Windows PowerShell, since that edition is guaranteed to exist and
 * pwsh is not — see CHM-39, where a machine had no pwsh at all.
 */
export function choosePowerShellEdition(
  isInstalled: Readonly<Record<PowerShellEdition, boolean>>,
  doesProfileExist: Readonly<Record<PowerShellEdition, boolean>>,
): PowerShellEdition | undefined {
  if (isInstalled.pwsh && !isInstalled.windowsPowerShell) return "pwsh";
  if (isInstalled.windowsPowerShell && !isInstalled.pwsh) return "windowsPowerShell";
  if (!isInstalled.pwsh && !isInstalled.windowsPowerShell) return undefined;
  return doesProfileExist.pwsh && !doesProfileExist.windowsPowerShell ? "pwsh" : "windowsPowerShell";
}

/** The binary name each PowerShell edition is installed under — `pwsh` never shares a binary name with Windows PowerShell's `powershell.exe`. */
const POWERSHELL_BINARY_NAMES: Readonly<Record<PowerShellEdition, string>> = {
  pwsh: "pwsh",
  windowsPowerShell: "powershell",
};

/** Whether `edition`'s own binary actually runs on this machine — the one thing that tells the two editions apart when neither's profile exists yet. */
function isPowerShellEditionInstalled(edition: PowerShellEdition): boolean {
  const result = spawnSync(POWERSHELL_BINARY_NAMES[edition], ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit"], {
    encoding: "utf8",
  });
  return !result.error && result.status === 0;
}

/**
 * The real detector behind choosePowerShellEdition's decision: which
 * edition(s) are actually installed, and which of the two profiles already
 * exists under `documentsDir`. Returns undefined only when neither edition's
 * binary runs at all.
 */
export function detectPowerShellEdition(documentsDir: string = windowsDocumentsDir()): PowerShellEdition | undefined {
  const isInstalled: Record<PowerShellEdition, boolean> = {
    pwsh: isPowerShellEditionInstalled("pwsh"),
    windowsPowerShell: isPowerShellEditionInstalled("windowsPowerShell"),
  };
  const doesProfileExist: Record<PowerShellEdition, boolean> = {
    pwsh: existsSync(powerShellProfilePathFor(documentsDir, "pwsh")),
    windowsPowerShell: existsSync(powerShellProfilePathFor(documentsDir, "windowsPowerShell")),
  };
  return choosePowerShellEdition(isInstalled, doesProfileExist);
}

/** The registry key Windows itself records a redirected special folder under — user-specific, never machine-wide, matching where OneDrive points Documents when it takes it over. */
const SHELL_FOLDERS_REGISTRY_KEY = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders`;

/** The value name Windows stores the Documents folder's own (possibly redirected) path under, inside SHELL_FOLDERS_REGISTRY_KEY — "Personal" is Windows' own historical name for Documents. */
const DOCUMENTS_SHELL_FOLDER_VALUE_NAME = "Personal";

/** Expands a `%VARIABLE%`-style reference the registry's own stored value can carry — e.g. `%USERPROFILE%\Documents` — leaving an unset variable's reference untouched rather than guessing. */
function expandWindowsEnvironmentReferences(rawPath: string): string {
  return rawPath.replace(/%([^%]+)%/g, (reference, name: string) => process.env[name] ?? reference);
}

/**
 * Parses `reg query`'s own tabular output for the Documents folder's stored
 * path — pure, so the redirected-vs-default cases are testable without
 * spawning `reg.exe` itself. Returns undefined for any output this project
 * does not recognise, rather than guessing.
 */
export function documentsDirFromRegistryQueryOutput(regQueryStdout: string): string | undefined {
  const match = regQueryStdout.match(/Personal\s+REG_(?:EXPAND_)?SZ\s+(.+)/);
  const rawValue = match?.[1]?.trim();
  return rawValue ? expandWindowsEnvironmentReferences(rawValue) : undefined;
}

/**
 * The real Documents folder — resolved from the registry key Windows itself
 * (or OneDrive, redirecting it) writes, rather than assumed at
 * `~/Documents`. `path.join(homedir(), "Documents")` is silently wrong the
 * moment Documents is redirected, which is common enough that CHM-39 was
 * filed over exactly this. Falls back to that same unredirected default only
 * when the registry lookup itself fails — off Windows, or on a Windows
 * install too locked down to run `reg query` at all.
 */
function windowsDocumentsDir(): string {
  const result = spawnSync("reg", ["query", SHELL_FOLDERS_REGISTRY_KEY, "/v", DOCUMENTS_SHELL_FOLDER_VALUE_NAME], { encoding: "utf8" });
  const registryDir = !result.error && result.status === 0 ? documentsDirFromRegistryQueryOutput(result.stdout) : undefined;
  return registryDir ?? path.join(homedir(), "Documents");
}

/**
 * Clink autoloads every `.lua` file in its own profile directory — Clink's
 * own default, `%LOCALAPPDATA%\clink`, unless a user has pointed `--profile`
 * elsewhere, which this project has no way to discover short of asking Clink
 * itself. This is the same directory Clink falls back to when LOCALAPPDATA
 * is unset — `~/.clink` — though that combination does not occur on a real
 * Windows install, where LOCALAPPDATA is always set.
 */
export function clinkScriptPath(): string {
  const localAppData = process.env["LOCALAPPDATA"];
  const clinkProfileDir = localAppData ? path.join(localAppData, "clink") : path.join(homedir(), ".clink");
  return path.join(clinkProfileDir, "chameleon-oh-my-posh.lua");
}
