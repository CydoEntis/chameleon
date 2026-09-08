export type Platform = "windows" | "linux" | "macos";
/**
 * Which of the three platforms `ch` is running under, from Node's own
 * `process.platform`. Takes that as an overridable argument, rather than
 * reading the global directly, so a test can exercise the non-host branch of
 * anything built on this without monkey-patching a Node global.
 */
export declare function currentPlatform(nodePlatform?: NodeJS.Platform): Platform;
export declare function isWindows(nodePlatform?: NodeJS.Platform): boolean;
/**
 * Chameleon's own state directory — the active-pack pointer, the Oh My Posh
 * pointer, and the user theme pack directory all live under this. Windows
 * keeps it under `%LOCALAPPDATA%`, matching every other per-user Windows app
 * data directory; everywhere else it follows the XDG Base Directory spec.
 */
export declare function stateDir(): string;
/**
 * Where Herdr keeps config.toml. Windows keeps it under `%APPDATA%` — Herdr's
 * own choice, not Chameleon's — and undefined when that is not set, so
 * `detect()` can report "not found" cleanly rather than throwing. Everywhere
 * else Herdr follows the XDG Base Directory spec, which always resolves to
 * something (a bare `homedir()` fallback), so there is no equivalent "unset"
 * case to report.
 */
export declare function herdrConfigPath(): string | undefined;
/**
 * Where Claude Code keeps settings.json — always under the user's home
 * directory, on every platform Claude Code ships for. Unlike Herdr or
 * Windows Terminal there is no OS-specific app-data directory to resolve and
 * no env var that can be missing, so this never returns undefined. See CHM-49.
 */
export declare function claudeCodeSettingsPath(): string;
export declare const SHELLS: readonly ["pwsh", "cmd", "bash", "zsh"];
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
export declare function detectShell(nodePlatform?: NodeJS.Platform): Shell;
/**
 * The interactive-startup file `shell`'s own Chameleon-owned init line
 * belongs in — read once, on every new shell, which is all that is needed
 * once that line names a fixed config path (see CHM-59). cmd.exe has no
 * such file of its own; its equivalent is a Clink Lua script instead, so it
 * is routed to clinkScriptPath rather than a profile.
 *
 * `pwsh` covers both PowerShell editions, and the two read *different*
 * profile files under *different* folder names — see
 * choosePowerShellEdition and windowsDocumentsDir. Assuming either one, the
 * way this used to hardcode PowerShell 7's `Documents\PowerShell`, writes
 * the init line to a file the installed edition never loads — see CHM-39.
 */
export declare function ohMyPoshProfilePathFor(shell: Shell): string;
export type PowerShellEdition = "pwsh" | "windowsPowerShell";
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
export declare function choosePowerShellEdition(isInstalled: Readonly<Record<PowerShellEdition, boolean>>, doesProfileExist: Readonly<Record<PowerShellEdition, boolean>>): PowerShellEdition | undefined;
/**
 * Clears every platform probe memoized below, so the next call recomputes
 * from a real spawn rather than reusing an earlier answer. Real callers
 * never call this — the whole point of the cache is that these answers are
 * constants for the process's lifetime. It exists for tests: CHM-35's
 * platform-override configs, and any test that stubs an env var these probes
 * read, need their very next probe to see that change rather than whatever
 * an earlier test in the same file already cached.
 */
export declare function resetPlatformProbeCache(): void;
/**
 * The real detector behind choosePowerShellEdition's decision: which
 * edition(s) are actually installed, and which of the two profiles already
 * exists under `documentsDir`. Returns undefined only when neither edition's
 * binary runs at all.
 */
export declare function detectPowerShellEdition(documentsDir?: string): PowerShellEdition | undefined;
/**
 * Parses `reg query`'s own tabular output for the Documents folder's stored
 * path — pure, so the redirected-vs-default cases are testable without
 * spawning `reg.exe` itself. Returns undefined for any output this project
 * does not recognise, rather than guessing.
 */
export declare function documentsDirFromRegistryQueryOutput(regQueryStdout: string): string | undefined;
/**
 * Clink autoloads every `.lua` file in its own profile directory — Clink's
 * own default, `%LOCALAPPDATA%\clink`, unless a user has pointed `--profile`
 * elsewhere, which this project has no way to discover short of asking Clink
 * itself. This is the same directory Clink falls back to when LOCALAPPDATA
 * is unset — `~/.clink` — though that combination does not occur on a real
 * Windows install, where LOCALAPPDATA is always set.
 */
export declare function clinkScriptPath(): string;
