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
 */
export function ohMyPoshProfilePathFor(shell: Shell): string {
  if (shell === "cmd") return clinkScriptPath();
  if (shell === "bash") return path.join(homedir(), ".bashrc");
  if (shell === "zsh") return path.join(process.env["ZDOTDIR"] || homedir(), ".zshrc");
  return path.join(homedir(), "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1");
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
