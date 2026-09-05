import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clinkScriptPath,
  currentPlatform,
  detectShell,
  herdrConfigPath,
  isWindows,
  ohMyPoshProfilePathFor,
  stateDir,
} from "../../src/adapters/platform.js";

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
});
