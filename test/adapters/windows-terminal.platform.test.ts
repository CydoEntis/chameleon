import { describe, expect, it, vi } from "vitest";

// CHM-25: Windows Terminal cannot exist off Windows. Before this fix,
// createWindowsTerminalAdapter()'s own default settingsPath threw on a
// LOCALAPPDATA read that could never resolve to anything real — detect()
// must report false cleanly instead. Mocking platform.ts's isWindows here,
// rather than process.platform itself, is what lets this exercise the
// non-Windows branch regardless of which platform the suite actually runs
// on — see platform.ts's own currentPlatform/isWindows, which take the same
// override for the same reason.
vi.mock("../../src/adapters/platform.js", () => ({ isWindows: () => false }));

describe("windows terminal adapter — off Windows", () => {
  it("detects false, cleanly, with no settingsPath to compute", async () => {
    const { createWindowsTerminalAdapter } = await import("../../src/adapters/windows-terminal.js");
    expect(createWindowsTerminalAdapter().detect()).toBe(false);
  });

  it("names the platform, not a missing env var, when read is attempted anyway", async () => {
    const { createWindowsTerminalAdapter } = await import("../../src/adapters/windows-terminal.js");
    expect(() => createWindowsTerminalAdapter().read()).toThrow(/not available on this platform/);
  });
});
