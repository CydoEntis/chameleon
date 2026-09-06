import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeCodeMatchesAppearance, createClaudeCodeAdapter, undoClaudeCode } from "../../src/adapters/claude-code.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(currentDir, "fixtures", "claude-code-settings.jsonc");

const CRLF = "\r\n";
const LF = "\n";

/**
 * True when every line of `original`, in order, appears verbatim somewhere
 * in `result` — i.e. `original`'s lines form a subsequence of `result`'s.
 * This is the byte-for-byte-outside-the-theme-key guarantee, checked without
 * re-implementing the adapter's own edit logic inside the test.
 */
function everyOriginalLineSurvivesInOrder(original: string, result: string): boolean {
  const originalLines = original.split(/\r\n|\n/);
  const resultLines = result.split(/\r\n|\n/);
  let originalIndex = 0;
  for (const resultLine of resultLines) {
    if (originalIndex < originalLines.length && resultLine === originalLines[originalIndex]) {
      originalIndex += 1;
    }
  }
  return originalIndex === originalLines.length;
}

/** The fixture's lines minus the one Chameleon is this ticket's job to *replace* — the pre-existing top-level "theme". Everything else — permissions, hooks, statusLine and both of the user's own comments included — must round-trip untouched. */
function linesUnrelatedToChameleonEdits(text: string, eol: string): string {
  return text
    .split(eol)
    .filter((line) => !/^\s*"theme":/.test(line))
    .join(eol);
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function usesOnlyLineEnding(text: string, eol: string): boolean {
  return eol === CRLF ? !/(?<!\r)\n/.test(text) : !text.includes("\r");
}

function parseWritten(text: string): unknown {
  return parseJsonc(text, [], { allowTrailingComma: true });
}

// The hostile fixture already carries \n only (see .gitattributes, which
// pins it there regardless of core.autocrlf) — both line-ending variants
// are derived from it here so the test never depends on how git or the
// filesystem happened to check the file out.
const LF_FIXTURE = readFileSync(FIXTURE_PATH, "utf8").replace(/\r\n/g, LF);
const CRLF_FIXTURE = LF_FIXTURE.replace(/\n/g, CRLF);

describe.each([
  { label: "CRLF", fixture: CRLF_FIXTURE, eol: CRLF },
  { label: "LF", fixture: LF_FIXTURE, eol: LF },
])("claude code adapter — $label fixture", ({ fixture, eol }) => {
  let settingsDir: string;
  let settingsPath: string;

  beforeEach(() => {
    settingsDir = mkdtempSync(path.join(tmpdir(), "chameleon-claude-code-"));
    settingsPath = path.join(settingsDir, "settings.json");
    writeFileSync(settingsPath, fixture, "utf8");
  });

  afterEach(() => {
    rmSync(settingsDir, { recursive: true, force: true });
  });

  it("detects Claude Code by the presence of its settings.json", () => {
    expect(createClaudeCodeAdapter(settingsPath).detect()).toBe(true);
    expect(createClaudeCodeAdapter(path.join(settingsDir, "missing.json")).detect()).toBe(false);
  });

  it("reads a hostile settings.json — comments, permissions, hooks and statusLine included", () => {
    const settings = createClaudeCodeAdapter(settingsPath).read();
    expect(settings.theme).toBe("light");
    expect(settings["statusLine"]).toEqual({ type: "command", command: "node ~/.claude/statusline.js" });
    expect(settings["permissions"]).toBeDefined();
    expect(settings["hooks"]).toBeDefined();
    expect(settings["enabledPlugins"]).toEqual({ "commit@aevox-playbook": true, "debt@aevox-playbook": true });
  });

  it("round-trips every original line byte-identical outside the theme key, its own line endings included", () => {
    createClaudeCodeAdapter(settingsPath).apply("dark");

    const resultText = readFileSync(settingsPath, "utf8");
    expect(everyOriginalLineSurvivesInOrder(linesUnrelatedToChameleonEdits(fixture, eol), resultText)).toBe(true);
    expect(usesOnlyLineEnding(resultText, eol)).toBe(true);
  });

  it("preserves permissions, hooks, statusLine and the user's own comments byte for byte", () => {
    createClaudeCodeAdapter(settingsPath).apply("dark");

    const resultText = readFileSync(settingsPath, "utf8");
    expect(resultText).toContain("// hooks I rely on for session setup, do not remove");
    expect(resultText).toContain('"command": "node ~/.claude/statusline.js"');
    expect(resultText).toContain('"Bash(npm run test:*)"');
    expect(resultText).toContain('"../shared-lib"');

    const parsed = parseWritten(resultText) as Record<string, unknown>;
    expect(parsed["permissions"]).toEqual((parseWritten(fixture) as Record<string, unknown>)["permissions"]);
    expect(parsed["hooks"]).toEqual((parseWritten(fixture) as Record<string, unknown>)["hooks"]);
    expect(parsed["statusLine"]).toEqual((parseWritten(fixture) as Record<string, unknown>)["statusLine"]);
    expect(parsed["enabledPlugins"]).toEqual((parseWritten(fixture) as Record<string, unknown>)["enabledPlugins"]);
  });

  // CHM-51: wrapping the edit in Chameleon's usual ch:begin/ch:end comment
  // markers is exactly what made Claude Code's own strict-JSON parser
  // discard the whole file — see the ticket body's own reproduction. This
  // adapter must never write either marker, anywhere in the file.
  it("never writes a ch:begin or ch:end marker into settings.json", () => {
    createClaudeCodeAdapter(settingsPath).apply("dark");

    const resultText = readFileSync(settingsPath, "utf8");
    expect(resultText).not.toContain("ch:begin");
    expect(resultText).not.toContain("ch:end");
  });

  it("leaves exactly one theme key, resolving to Chameleon's value, when one already existed", () => {
    expect(fixture).toContain('"theme": "light"');

    createClaudeCodeAdapter(settingsPath).apply("dark");

    const resultText = readFileSync(settingsPath, "utf8");
    expect(countOccurrences(resultText, '"theme"')).toBe(1);
    const parsed = parseWritten(resultText) as { theme?: unknown };
    expect(parsed.theme).toBe("dark-ansi");
  });

  it("is idempotent — applying the same appearance twice produces the same file", () => {
    const adapter = createClaudeCodeAdapter(settingsPath);

    adapter.apply("dark");
    const afterFirstApply = readFileSync(settingsPath, "utf8");
    adapter.apply("dark");
    const afterSecondApply = readFileSync(settingsPath, "utf8");

    expect(afterSecondApply).toBe(afterFirstApply);
    expect(countOccurrences(afterSecondApply, '"theme"')).toBe(1);
  });

  it("upserts the theme in place when appearance switches, instead of growing the file", () => {
    const adapter = createClaudeCodeAdapter(settingsPath);

    adapter.apply("dark");
    const lengthAfterFirstApply = readFileSync(settingsPath, "utf8").length;
    adapter.apply("light");
    const resultText = readFileSync(settingsPath, "utf8");

    const parsed = parseWritten(resultText) as { theme?: unknown };
    expect(parsed.theme).toBe("light-ansi");
    expect(countOccurrences(resultText, '"theme"')).toBe(1);
    // A true in-place swap only ever changes by exactly the difference
    // between the two quoted theme values — never by a marker's worth of
    // comment lines on top. See CHM-43, where a marked block instead
    // compounded a little more onto the file on every apply.
    const quotedValueLengthDelta = JSON.stringify("light-ansi").length - JSON.stringify("dark-ansi").length;
    expect(resultText.length).toBe(lengthAfterFirstApply + quotedValueLengthDelta);
  });

  it("writes a backup before every apply, and undo restores it exactly", () => {
    createClaudeCodeAdapter(settingsPath).apply("dark");
    expect(readFileSync(settingsPath, "utf8")).not.toBe(fixture);
    expect(readFileSync(`${settingsPath}.chameleon-backup`, "utf8")).toBe(fixture);

    undoClaudeCode(settingsPath);
    expect(readFileSync(settingsPath, "utf8")).toBe(fixture);
  });
});

// CHM-49's acceptance criteria: a dark pack sets dark-ansi, a light pack sets
// light-ansi — the two variants that render straight from the terminal's own
// ANSI palette, which Chameleon already writes and repairs (CHM-32).
describe("claude code adapter — appearance mapping", () => {
  let settingsDir: string;
  let settingsPath: string;

  beforeEach(() => {
    settingsDir = mkdtempSync(path.join(tmpdir(), "chameleon-claude-code-mapping-"));
    settingsPath = path.join(settingsDir, "settings.json");
    writeFileSync(settingsPath, "{}", "utf8");
  });

  afterEach(() => {
    rmSync(settingsDir, { recursive: true, force: true });
  });

  it("sets dark-ansi for a dark pack", () => {
    createClaudeCodeAdapter(settingsPath).apply("dark");
    expect(createClaudeCodeAdapter(settingsPath).read().theme).toBe("dark-ansi");
  });

  it("sets light-ansi for a light pack", () => {
    createClaudeCodeAdapter(settingsPath).apply("light");
    expect(createClaudeCodeAdapter(settingsPath).read().theme).toBe("light-ansi");
  });
});

// CHM-49: "never silently discard an accessibility choice" — a user on
// dark-daltonized or light-daltonized must stay daltonized, asserted by name,
// with only the light/dark half moving.
describe("claude code adapter — daltonized themes stay daltonized", () => {
  let settingsDir: string;
  let settingsPath: string;

  beforeEach(() => {
    settingsDir = mkdtempSync(path.join(tmpdir(), "chameleon-claude-code-daltonized-"));
    settingsPath = path.join(settingsDir, "settings.json");
  });

  afterEach(() => {
    rmSync(settingsDir, { recursive: true, force: true });
  });

  it("keeps dark-daltonized when a dark pack is applied", () => {
    writeFileSync(settingsPath, JSON.stringify({ theme: "dark-daltonized", effortLevel: "high" }, null, 2), "utf8");
    createClaudeCodeAdapter(settingsPath).apply("dark");
    expect(createClaudeCodeAdapter(settingsPath).read().theme).toBe("dark-daltonized");
  });

  it("switches dark-daltonized to light-daltonized when a light pack is applied — the half moves, the choice doesn't", () => {
    writeFileSync(settingsPath, JSON.stringify({ theme: "dark-daltonized", effortLevel: "high" }, null, 2), "utf8");
    createClaudeCodeAdapter(settingsPath).apply("light");
    expect(createClaudeCodeAdapter(settingsPath).read().theme).toBe("light-daltonized");
  });

  it("switches light-daltonized to dark-daltonized when a dark pack is applied", () => {
    writeFileSync(settingsPath, JSON.stringify({ theme: "light-daltonized", effortLevel: "high" }, null, 2), "utf8");
    createClaudeCodeAdapter(settingsPath).apply("dark");
    expect(createClaudeCodeAdapter(settingsPath).read().theme).toBe("dark-daltonized");
  });

  it("never moves a daltonized user onto a plain ansi variant", () => {
    writeFileSync(settingsPath, JSON.stringify({ theme: "light-daltonized", effortLevel: "high" }, null, 2), "utf8");
    createClaudeCodeAdapter(settingsPath).apply("dark");
    const theme = createClaudeCodeAdapter(settingsPath).read().theme;
    expect(theme).not.toBe("dark-ansi");
    expect(theme).toBe("dark-daltonized");
  });
});

describe("claude code adapter — edge cases", () => {
  let settingsDir: string;

  beforeEach(() => {
    settingsDir = mkdtempSync(path.join(tmpdir(), "chameleon-claude-code-edge-"));
  });

  afterEach(() => {
    rmSync(settingsDir, { recursive: true, force: true });
  });

  it("names the file and the problem when a config it must edit is shaped wrong", () => {
    const malformedPath = path.join(settingsDir, "malformed.json");
    writeFileSync(malformedPath, JSON.stringify({ theme: 123 }), "utf8");
    expect(() => createClaudeCodeAdapter(malformedPath).read()).toThrow(malformedPath);
  });

  it("refuses to apply when there is no settings.json to edit — Claude Code absent is skipped elsewhere, never guessed at here", () => {
    const adapter = createClaudeCodeAdapter(path.join(settingsDir, "missing.json"));
    expect(() => adapter.apply("dark")).toThrow();
  });

  it("never leaves a dangling comma when settings.json starts out empty", () => {
    const settingsPath = path.join(settingsDir, "minimal.json");
    writeFileSync(settingsPath, "{}", "utf8");

    createClaudeCodeAdapter(settingsPath).apply("dark");

    const resultText = readFileSync(settingsPath, "utf8");
    expect(resultText).not.toMatch(/,\s*[\]}]/);
  });

  // CHM-49/CHM-45: Claude Code has no live reload of its own to trigger, so
  // this must say so plainly rather than silently claiming success.
  it("reload always names the restart the user needs, never a silent success", () => {
    const settingsPath = path.join(settingsDir, "settings.json");
    writeFileSync(settingsPath, "{}", "utf8");
    expect(createClaudeCodeAdapter(settingsPath).reload()).toBe("restart Claude Code to see it");
  });
});

// CHM-68: applying a theme also sets up `chm statusline` as Claude Code's
// own statusLine — but only when the key was never there at all, and never
// overwriting a script a user wrote themselves.
describe("claude code adapter — statusLine (CHM-68)", () => {
  let settingsDir: string;
  let settingsPath: string;

  beforeEach(() => {
    settingsDir = mkdtempSync(path.join(tmpdir(), "chameleon-claude-code-statusline-"));
    settingsPath = path.join(settingsDir, "settings.json");
  });

  afterEach(() => {
    rmSync(settingsDir, { recursive: true, force: true });
  });

  it("sets statusLine to `chm statusline` when the key is entirely absent — no separate install step", () => {
    writeFileSync(settingsPath, JSON.stringify({ theme: "light" }, null, 2), "utf8");

    createClaudeCodeAdapter(settingsPath).apply("dark");

    expect(createClaudeCodeAdapter(settingsPath).read().statusLine).toEqual({ type: "command", command: "chm statusline" });
  });

  it("says nothing on the apply that sets statusLine for the first time — that already just works", () => {
    writeFileSync(settingsPath, JSON.stringify({ theme: "light" }, null, 2), "utf8");

    const notice = createClaudeCodeAdapter(settingsPath).apply("dark");

    expect(notice).toBeUndefined();
  });

  it("never overwrites a statusLine the user already had", () => {
    writeFileSync(settingsPath, JSON.stringify({ theme: "light", statusLine: { type: "command", command: "node ~/.claude/statusline.js" } }, null, 2), "utf8");

    createClaudeCodeAdapter(settingsPath).apply("dark");

    expect(createClaudeCodeAdapter(settingsPath).read().statusLine).toEqual({ type: "command", command: "node ~/.claude/statusline.js" });
  });

  it("says so, once, the first time it notices a pre-existing statusLine", () => {
    writeFileSync(settingsPath, JSON.stringify({ theme: "light", statusLine: { type: "command", command: "node ~/.claude/statusline.js" } }, null, 2), "utf8");

    const notice = createClaudeCodeAdapter(settingsPath).apply("dark");

    expect(notice).toContain("statusLine is already set");
  });

  // CHM-68's own acceptance criterion: "says so at most once rather than on
  // every apply" — a second, third, fourth apply against the same
  // settings.json must all stay silent about it.
  it("never repeats the pre-existing-statusLine notice on a later apply", () => {
    writeFileSync(settingsPath, JSON.stringify({ theme: "light", statusLine: { type: "command", command: "node ~/.claude/statusline.js" } }, null, 2), "utf8");
    const adapter = createClaudeCodeAdapter(settingsPath);

    const firstNotice = adapter.apply("dark");
    const secondNotice = adapter.apply("light");
    const thirdNotice = adapter.apply("dark");

    expect(firstNotice).toContain("statusLine is already set");
    expect(secondNotice).toBeUndefined();
    expect(thirdNotice).toBeUndefined();
  });

  it("leaves every other key byte-identical when it sets statusLine for the first time", () => {
    const fixture = JSON.stringify({ theme: "light", permissions: { allow: ["Bash(npm run test:*)"] }, effortLevel: "high" }, null, 2);
    writeFileSync(settingsPath, fixture, "utf8");

    createClaudeCodeAdapter(settingsPath).apply("dark");

    const parsed = parseWritten(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    expect(parsed["permissions"]).toEqual({ allow: ["Bash(npm run test:*)"] });
    expect(parsed["effortLevel"]).toBe("high");
  });

  it("never writes a ch:begin or ch:end marker for statusLine either", () => {
    writeFileSync(settingsPath, "{}", "utf8");

    createClaudeCodeAdapter(settingsPath).apply("dark");

    const resultText = readFileSync(settingsPath, "utf8");
    expect(resultText).not.toContain("ch:begin");
    expect(resultText).not.toContain("ch:end");
  });
});

// CHM-27: this is the exact comparison `ch current`/`ch doctor` use to
// notice a target that has drifted from the recorded pack. There is no
// marker in settings.json for this to key off (see CHM-51) — it is always a
// direct value comparison.
describe("claudeCodeMatchesAppearance", () => {
  let settingsDir: string;
  let settingsPath: string;

  beforeEach(() => {
    settingsDir = mkdtempSync(path.join(tmpdir(), "chameleon-claude-code-drift-"));
    settingsPath = path.join(settingsDir, "settings.json");
    writeFileSync(settingsPath, "{}", "utf8");
  });

  afterEach(() => {
    rmSync(settingsDir, { recursive: true, force: true });
  });

  it("matches right after apply", () => {
    const adapter = createClaudeCodeAdapter(settingsPath);
    adapter.apply("dark");

    expect(claudeCodeMatchesAppearance(adapter.read(), "dark")).toBe(true);
  });

  it("does not match the other appearance", () => {
    const adapter = createClaudeCodeAdapter(settingsPath);
    adapter.apply("dark");

    expect(claudeCodeMatchesAppearance(adapter.read(), "light")).toBe(false);
  });

  it("does not match a config that was never themed by Chameleon at all", () => {
    expect(claudeCodeMatchesAppearance(createClaudeCodeAdapter(settingsPath).read(), "dark")).toBe(false);
  });

  it("still matches a daltonized theme against the appearance whose half it already carries", () => {
    writeFileSync(settingsPath, JSON.stringify({ theme: "dark-daltonized" }), "utf8");
    expect(claudeCodeMatchesAppearance(createClaudeCodeAdapter(settingsPath).read(), "dark")).toBe(true);
    expect(claudeCodeMatchesAppearance(createClaudeCodeAdapter(settingsPath).read(), "light")).toBe(false);
  });
});

// CHM-51's own acceptance criterion: Chameleon's own tolerant JSONC parser
// agreeing the file still parses is not proof Claude Code itself accepts it
// — that is exactly how the ch:begin/ch:end marker bug shipped in the first
// place (CHM-49's own test suite re-parsed with jsonc-parser and stayed
// green throughout). This runs the real `claude` CLI, pointed at a sandbox
// config dir via CLAUDE_CONFIG_DIR, and checks its own "doctor" output
// directly. Skipped, rather than failed, when the `claude` binary is not on
// PATH — CI and a contributor's machine are not guaranteed to have it — but
// it is the check that actually caught this bug and must run wherever it can.
const claudeCliCheck = spawnSync("claude", ["--version"], { encoding: "utf8" });
const isClaudeCliAvailable = !claudeCliCheck.error && claudeCliCheck.status === 0;

describe.runIf(isClaudeCliAvailable)("claude code adapter — verified against the real Claude Code CLI", () => {
  let configDir: string;
  let settingsPath: string;

  beforeEach(() => {
    configDir = mkdtempSync(path.join(tmpdir(), "chameleon-claude-code-real-cli-"));
    settingsPath = path.join(configDir, "settings.json");
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  /** `claude doctor`'s own report against `configDir`, via CLAUDE_CONFIG_DIR — the exact reproduction CHM-51's own ticket body used. */
  function runClaudeDoctor(): string {
    const result = spawnSync("claude", ["doctor"], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
    });
    return result.stdout;
  }

  it("is accepted by the real Claude Code CLI after Chameleon applies a theme", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ effortLevel: "high", theme: "light", autoUpdatesChannel: "stable" }, null, 2),
      "utf8",
    );

    createClaudeCodeAdapter(settingsPath).apply("dark");

    expect(runClaudeDoctor()).not.toContain("Invalid settings");
  });

  it("reproduces CHM-51 when the old marker-wrapped shape is written instead — proving this check catches the bug it exists for", () => {
    const markerWrappedSettings = ["{", '  "effortLevel": "high",', "  // ch:begin theme", '  "theme": "dark-ansi",', "  // ch:end theme", '  "autoUpdatesChannel": "stable"', "}", ""].join(
      "\n",
    );
    writeFileSync(settingsPath, markerWrappedSettings, "utf8");

    expect(runClaudeDoctor()).toContain("Invalid settings");
  });
});
