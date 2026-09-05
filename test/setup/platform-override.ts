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
