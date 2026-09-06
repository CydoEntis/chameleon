/**
 * CHM-35: lets the whole suite run as though it were on a different OS,
 * without needing an actual host of that kind. Every platform branch in
 * adapters/platform.ts (currentPlatform, isWindows, detectShell) reads the
 * real `process.platform` only as its *default* argument, so overriding the
 * global once, before any test file runs, is enough to flip every one of
 * them at once — no per-call mocking required.
 *
 * `CHAMELEON_TEST_PLATFORM` is set by vitest.config.linux.ts and
 * vitest.config.darwin.ts's own `test.env`, never by hand. A bare `npm test`
 * run never sets it, so the default config — and CI's real host platform —
 * is untouched.
 */
const overridePlatform = process.env["CHAMELEON_TEST_PLATFORM"];
if (overridePlatform) {
  Object.defineProperty(process, "platform", { value: overridePlatform });
}

/**
 * CHM-72: every environment variable src/adapters/ itself reads by name to
 * discover a pre-existing config or tool, enumerated straight from those
 * reads — `oh-my-posh.ts`'s POSH_CONFIG/POSH_THEME, and `platform.ts`'s
 * XDG_DATA_HOME/XDG_CONFIG_HOME/APPDATA/PSModulePath/SHELL/ZDOTDIR.
 *
 * Excluded on purpose:
 *   - The `$env:VAR`/`%VAR%` expansion helpers in oh-my-posh.ts and
 *     platform.ts, which resolve whatever name a profile or config text
 *     happens to reference and so name no variable of their own to enumerate
 *     here.
 *   - LOCALAPPDATA (platform.ts, windows-terminal.ts). Every other variable
 *     here signals an *optional* integration — Oh My Posh may never have run
 *     `init`, XDG_CONFIG_HOME may never be set, cmd.exe never sets
 *     PSModulePath — so the code that reads it always has a graceful "not
 *     configured" path, and clearing it reproduces a real machine that
 *     genuinely lacks that integration. LOCALAPPDATA is not optional: it is
 *     Windows itself, present on every real Windows install including every
 *     CI runner, and stateDir()/defaultWindowsTerminalSettingsPath() throw
 *     rather than degrade when it is missing precisely because that never
 *     happens for real. Clearing it here would not reproduce a clean CI box
 *     — CI has it too — it would only manufacture a machine that cannot
 *     exist and break every test that has not itself stubbed it. A test that
 *     specifically wants the unset-LOCALAPPDATA error path already does so
 *     with its own vi.stubEnv("LOCALAPPDATA", "").
 *
 * Three tickets — CHM-36, CHM-59, CHM-71 — each shipped a test that built a
 * fixture and asserted discovery found it, and each one instead silently
 * found whatever the developer's own machine actually had exported, because
 * resolveConfigPath prefers the environment over any fixture it is handed.
 * Every maintainer's machine has one of these set; no CI machine does — which
 * is exactly why each bug shipped invisibly and was only ever caught by
 * accident. Clearing all of them once, here, before any test file's own
 * module even loads, is what makes that impossible: a test that wants one set
 * again does so explicitly with vi.stubEnv, which then reads as a deliberate
 * choice rather than an accident of the host running the suite.
 */
export const DISCOVERY_ENV_VARS = [
  "POSH_CONFIG",
  "POSH_THEME",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "APPDATA",
  "PSModulePath",
  "SHELL",
  "ZDOTDIR",
] as const;

for (const discoveryEnvVar of DISCOVERY_ENV_VARS) {
  delete process.env[discoveryEnvVar];
}
