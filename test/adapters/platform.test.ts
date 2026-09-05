import type { SpawnSyncReturns } from "node:child_process";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  choosePowerShellEdition,
  clinkScriptPath,
  currentPlatform,
  detectPowerShellEdition,
  detectShell,
  documentsDirFromRegistryQueryOutput,
  herdrConfigPath,
  isWindows,
  ohMyPoshProfilePathFor,
  resetPlatformProbeCache,
  stateDir,
  type PowerShellEdition,
} from "../../src/adapters/platform.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

function makeSpawnResult(overrides: Partial<SpawnSyncReturns<string>> = {}): SpawnSyncReturns<string> {
  return {
    pid: 1234,
    output: [null, "", ""],
    stdout: "",
    stderr: "",
    status: 0,
    signal: null,
    ...overrides,
  };
}

/** `reg query`'s own not-found shape — every spawnSync call in this file defaults to this so a test that never touches PowerShell detection or Documents redirection is unaffected by it. */
const REG_QUERY_NOT_FOUND = makeSpawnResult({ error: new Error("ENOENT"), status: null });

beforeEach(() => {
  vi.mocked(spawnSync).mockReset().mockReturnValue(REG_QUERY_NOT_FOUND);
  // CHM-54: isPowerShellEditionInstalled and windowsDocumentsDir now memoize
  // their spawnSync result for the process's lifetime, so a test relying on
  // a fresh spawnSync sequence (mockReturnValueOnce) needs a fresh probe
  // cache too — otherwise it silently observes whatever an earlier test in
  // this file already cached, rather than its own mocked responses.
  resetPlatformProbeCache();
});

// CHM-25: before this file existed, every one of these paths was a scattered
// LOCALAPPDATA/APPDATA/USERPROFILE read that threw outright when its own env
// var was unset — which is every Linux machine. `currentPlatform` and
// `detectShell` take the Node platform as an overridable argument precisely
// so these tests can exercise the non-host branch without monkey-patching
// `process.platform` itself.

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("currentPlatform / isWindows", () => {
  it("reports windows for win32", () => {
    expect(currentPlatform("win32")).toBe("windows");
    expect(isWindows("win32")).toBe(true);
  });

  it("reports macos for darwin", () => {
    expect(currentPlatform("darwin")).toBe("macos");
    expect(isWindows("darwin")).toBe(false);
  });

  it("reports linux for anything else", () => {
    expect(currentPlatform("linux")).toBe("linux");
    expect(isWindows("linux")).toBe(false);
  });
});

describe("stateDir", () => {
  it("throws when LOCALAPPDATA is unset on Windows", () => {
    vi.stubEnv("LOCALAPPDATA", "");
    // stateDir() always reads the real process.platform — this assertion
    // only holds when these tests themselves run on Windows, which every
    // targeted CI leg for this repo does. See CHM-25's own acceptance
    // criterion "the suite passes on Linux as well as Windows": stateDir's
    // Linux branch never reaches this code path at all, since XDG always
    // resolves to something.
    if (isWindows()) {
      expect(() => stateDir()).toThrow(/LOCALAPPDATA/);
    }
  });

  it("never throws when XDG_DATA_HOME is set — the state dir sits under it", () => {
    if (isWindows()) return; // Windows always takes the LOCALAPPDATA branch above.
    const xdgDataHome = path.join(path.sep, "tmp", "chameleon-xdg-data");
    vi.stubEnv("XDG_DATA_HOME", xdgDataHome);
    expect(stateDir()).toBe(path.join(xdgDataHome, "chameleon"));
  });
});

describe("herdrConfigPath", () => {
  it("returns undefined when APPDATA is unset on Windows", () => {
    vi.stubEnv("APPDATA", "");
    if (isWindows()) {
      expect(herdrConfigPath()).toBeUndefined();
    }
  });

  it("resolves under XDG_CONFIG_HOME when not on Windows", () => {
    if (isWindows()) return;
    const xdgConfigHome = path.join(path.sep, "tmp", "chameleon-xdg-config");
    vi.stubEnv("XDG_CONFIG_HOME", xdgConfigHome);
    expect(herdrConfigPath()).toBe(path.join(xdgConfigHome, "herdr", "config.toml"));
  });
});

describe("detectShell", () => {
  it("picks pwsh on Windows when PSModulePath is set", () => {
    vi.stubEnv("PSModulePath", "C:\\Program Files\\PowerShell\\Modules");
    expect(detectShell("win32")).toBe("pwsh");
  });

  it("picks cmd on Windows when PSModulePath is unset — cmd.exe never sets it", () => {
    vi.stubEnv("PSModulePath", "");
    expect(detectShell("win32")).toBe("cmd");
  });

  it("picks zsh when $SHELL names zsh", () => {
    vi.stubEnv("SHELL", "/usr/bin/zsh");
    expect(detectShell("linux")).toBe("zsh");
  });

  it("falls back to bash for any other POSIX login shell, including an unset $SHELL", () => {
    vi.stubEnv("SHELL", "/bin/bash");
    expect(detectShell("linux")).toBe("bash");
    vi.stubEnv("SHELL", "");
    expect(detectShell("darwin")).toBe("bash");
  });
});

describe("ohMyPoshProfilePathFor", () => {
  it("routes cmd to the Clink script path, not a shell profile", () => {
    expect(ohMyPoshProfilePathFor("cmd")).toBe(clinkScriptPath());
  });

  it("routes zsh to $ZDOTDIR/.zshrc when ZDOTDIR is set", () => {
    const zdotdir = path.join(path.sep, "home", "example", ".zsh-config");
    vi.stubEnv("ZDOTDIR", zdotdir);
    expect(ohMyPoshProfilePathFor("zsh")).toBe(path.join(zdotdir, ".zshrc"));
  });

  it("gives pwsh, bash and zsh each their own, distinct path", () => {
    const paths = new Set(["pwsh", "bash", "zsh", "cmd"].map((shell) => ohMyPoshProfilePathFor(shell as never)));
    expect(paths.size).toBe(4);
  });

  // CHM-39: a real machine had Windows PowerShell 5.1, no pwsh at all, and
  // Documents redirected to OneDrive — and Chameleon wrote its reload hook
  // to `~/Documents/PowerShell/...` regardless, a file nothing ever loaded.
  it("writes to Windows PowerShell's own profile, under a OneDrive-redirected Documents, when pwsh is not installed", () => {
    const oneDriveDocuments = String.raw`C:\Users\cstin\OneDrive\Documents`;
    vi.mocked(spawnSync)
      .mockReturnValueOnce(
        makeSpawnResult({
          status: 0,
          stdout: [
            String.raw`HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders`,
            `    Personal    REG_EXPAND_SZ    ${oneDriveDocuments}`,
            "",
          ].join("\r\n"),
        }),
      )
      .mockReturnValueOnce(makeSpawnResult({ error: new Error("ENOENT"), status: null })) // pwsh: not installed
      .mockReturnValueOnce(makeSpawnResult({ status: 0 })); // powershell: installed

    expect(ohMyPoshProfilePathFor("pwsh")).toBe(path.join(oneDriveDocuments, "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1"));
  });
});

describe("documentsDirFromRegistryQueryOutput", () => {
  it("reads a literal, OneDrive-redirected path from a real `reg query` REG_EXPAND_SZ line", () => {
    const stdout = [
      String.raw`HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders`,
      String.raw`    Personal    REG_EXPAND_SZ    C:\Users\cstin\OneDrive\Documents`,
      "",
    ].join("\r\n");
    expect(documentsDirFromRegistryQueryOutput(stdout)).toBe(String.raw`C:\Users\cstin\OneDrive\Documents`);
  });

  it("expands a %USERPROFILE%-style reference the unredirected default is stored with", () => {
    vi.stubEnv("USERPROFILE", String.raw`C:\Users\cstin`);
    const stdout = String.raw`    Personal    REG_SZ    %USERPROFILE%\Documents`;
    expect(documentsDirFromRegistryQueryOutput(stdout)).toBe(String.raw`C:\Users\cstin\Documents`);
  });

  it("returns undefined for output that names no Personal value — reg query failed or the key does not exist", () => {
    expect(documentsDirFromRegistryQueryOutput("ERROR: The system was unable to find the specified registry key.")).toBeUndefined();
  });
});

describe("choosePowerShellEdition", () => {
  const installed = (pwsh: boolean, windowsPowerShell: boolean): Readonly<Record<PowerShellEdition, boolean>> => ({
    pwsh,
    windowsPowerShell,
  });
  const profileExists = (pwsh: boolean, windowsPowerShell: boolean): Readonly<Record<PowerShellEdition, boolean>> => ({
    pwsh,
    windowsPowerShell,
  });

  it("picks the only edition installed, regardless of which profile exists", () => {
    expect(choosePowerShellEdition(installed(true, false), profileExists(false, true))).toBe("pwsh");
    expect(choosePowerShellEdition(installed(false, true), profileExists(true, false))).toBe("windowsPowerShell");
  });

  it("returns undefined when neither edition is installed", () => {
    expect(choosePowerShellEdition(installed(false, false), profileExists(false, false))).toBeUndefined();
  });

  it("prefers whichever edition's profile already exists when both are installed", () => {
    expect(choosePowerShellEdition(installed(true, true), profileExists(true, false))).toBe("pwsh");
    expect(choosePowerShellEdition(installed(true, true), profileExists(false, true))).toBe("windowsPowerShell");
  });

  it("falls back to Windows PowerShell — never pwsh — on a tie between two installed editions", () => {
    expect(choosePowerShellEdition(installed(true, true), profileExists(false, false))).toBe("windowsPowerShell");
    expect(choosePowerShellEdition(installed(true, true), profileExists(true, true))).toBe("windowsPowerShell");
  });
});

// CHM-54: detectPowerShellEdition and windowsDocumentsDir (reached here
// through detectPowerShellEdition's own documentsDir default) each used to
// spawn a process on every call. Neither answer — which PowerShell editions
// are installed, and where Documents really is — can change while `ch` is
// running, so both are now memoized for the process's lifetime.

/** CHM-54's own acceptance number for a memoized (second-or-later) probe. */
const MEMOIZED_CALL_BUDGET_MS = 5;

describe("platform probe memoization (CHM-54)", () => {
  it("spawns a process for the registry query and each PowerShell edition only once per process, no matter how many times detection runs", () => {
    detectPowerShellEdition();
    const spawnCallsAfterFirstDetection = vi.mocked(spawnSync).mock.calls.length;
    expect(spawnCallsAfterFirstDetection).toBeGreaterThan(0);

    detectPowerShellEdition();
    detectPowerShellEdition();

    // Every further call reuses the memoized answers — no additional spawning.
    expect(vi.mocked(spawnSync).mock.calls.length).toBe(spawnCallsAfterFirstDetection);
  });

  it("a second detection costs under 5ms once the first has already paid the real spawn cost — the number CHM-54 exists to fix", () => {
    // spawnSync blocks Node's event loop synchronously, so a mock standing
    // in for a real PowerShell/registry cold start has to block the same
    // way to reproduce the actual defect — a plain mockReturnValue returns
    // instantly and would prove nothing. This keeps the assertion
    // deterministic across CI hosts, rather than depending on how long a
    // real "powershell"/"reg" happens to take on whichever machine runs it.
    const SIMULATED_SPAWN_LATENCY_MS = 20;
    vi.mocked(spawnSync).mockImplementation(() => {
      const deadline = Date.now() + SIMULATED_SPAWN_LATENCY_MS;
      while (Date.now() < deadline) {
        // Busy-wait: see the comment above for why this can't just await.
      }
      return REG_QUERY_NOT_FOUND;
    });

    const firstCallStart = Date.now();
    detectPowerShellEdition();
    const firstCallDurationMs = Date.now() - firstCallStart;
    expect(firstCallDurationMs).toBeGreaterThanOrEqual(SIMULATED_SPAWN_LATENCY_MS);

    const secondCallStart = Date.now();
    detectPowerShellEdition();
    const secondCallDurationMs = Date.now() - secondCallStart;
    expect(secondCallDurationMs).toBeLessThan(MEMOIZED_CALL_BUDGET_MS);
  });

  it("resetPlatformProbeCache() forces the next detection to spawn fresh, for a test that changes what a probe would find", () => {
    detectPowerShellEdition();
    const spawnCallsBeforeReset = vi.mocked(spawnSync).mock.calls.length;

    resetPlatformProbeCache();
    detectPowerShellEdition();

    expect(vi.mocked(spawnSync).mock.calls.length).toBeGreaterThan(spawnCallsBeforeReset);
  });
});
