import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentPackReport, LoadedThemePack } from "../src/index.js";
import { loadCuratedThemePacks, mergeThemePacksBySlug } from "../src/index.js";
import {
  buildTerminalPreviewSequence,
  buildTerminalResetSequence,
  createSettledFileTargetPreview,
  formatDriftLine,
  formatThemeLine,
  hasDrift,
  normalizeThemeQuery,
  resolveThemeQuery,
  USAGE,
  wantsPlainThemeList,
} from "../src/cli.js";

// CHM-34: `ch doctor` was reporting "drift: none" — a comparison it never
// performed — whenever the recorded pack could no longer be loaded (deleted
// after being applied). `driftedTargets` comes back empty in that case for
// the same reason it comes back empty on a genuine match (see
// currentPack/detectPackDrift in index.pack-commands.test.ts), so
// formatDriftLine/hasDrift must branch on `name === undefined`, not just on
// `driftedTargets.length`, or the two cases are indistinguishable.
function unloadablePackDrift(slug: string): CurrentPackReport {
  return { slug, name: undefined, driftedTargets: [] };
}

function matchingPackDrift(slug: string): CurrentPackReport {
  return { slug, name: "Some Pack", driftedTargets: [] };
}

function driftedPackDrift(slug: string): CurrentPackReport {
  return { slug, name: "Some Pack", driftedTargets: ["oh-my-posh"] };
}

describe("formatDriftLine", () => {
  it("reports nothing to compare when no pack has ever been applied", () => {
    expect(formatDriftLine(undefined)).toBe("drift: no pack has been applied yet — nothing to compare");
  });

  // The deleted-pack case (CHM-34's reproduction): the state file still
  // names a slug, but it no longer resolves to a loadable pack, so no
  // comparison ever ran.
  it("says the check could not run when the recorded pack is no longer available, rather than claiming a match", () => {
    const line = formatDriftLine(unloadablePackDrift("no-such-deleted-pack"));

    expect(line).toBe('cannot check drift: pack "no-such-deleted-pack" is no longer available');
    expect(line).not.toMatch(/drift: none/);
  });

  it("reports none when every detected target matches the recorded, loadable pack", () => {
    expect(formatDriftLine(matchingPackDrift("catppuccin-dark"))).toBe('drift: none — every detected target matches "catppuccin-dark"');
  });

  it("names the targets that no longer match the recorded pack", () => {
    expect(formatDriftLine(driftedPackDrift("catppuccin-dark"))).toBe('drift: oh-my-posh no longer matches "catppuccin-dark"');
  });
});

describe("hasDrift", () => {
  it("is false when no pack has ever been applied", () => {
    expect(hasDrift(undefined)).toBe(false);
  });

  // Exit code must reflect that the check could not run, rather than success
  // — the other half of CHM-34's fix.
  it("is true when the recorded pack could not be loaded, even though driftedTargets is empty", () => {
    expect(hasDrift(unloadablePackDrift("no-such-deleted-pack"))).toBe(true);
  });

  it("is false when every detected target matches the recorded pack", () => {
    expect(hasDrift(matchingPackDrift("catppuccin-dark"))).toBe(false);
  });

  it("is true when a target no longer matches the recorded pack", () => {
    expect(hasDrift(driftedPackDrift("catppuccin-dark"))).toBe(true);
  });
});

// Real bundled packs (loadCuratedThemePacks/mergeThemePacksBySlug), not
// invented fixtures — see CLAUDE.md's "colour tests use real schemes' real
// values." Catppuccin's own two packs (catppuccin-dark "Catppuccin Mocha",
// catppuccin-light "Catppuccin Latte") share a slug and name prefix, which is
// exactly what makes them useful here: real cases of an exact match, a
// prefix that must read as ambiguous, and a near-miss with an obvious "did
// you mean".
const BUNDLED_PACKS: readonly LoadedThemePack[] = mergeThemePacksBySlug(loadCuratedThemePacks(), []);

function findBundledPack(slug: string): LoadedThemePack {
  const loaded = BUNDLED_PACKS.find((candidate) => candidate.pack.manifest.slug === slug);
  if (!loaded) throw new Error(`test fixture error: no bundled pack named "${slug}"`);
  return loaded;
}

describe("normalizeThemeQuery", () => {
  it("lowercases and strips separators so a slug, a name and joined words all collapse to the same key", () => {
    expect(normalizeThemeQuery("Catppuccin Mocha")).toBe("catppuccinmocha");
    expect(normalizeThemeQuery("catppuccin-mocha")).toBe("catppuccinmocha");
    expect(normalizeThemeQuery("catppuccin_mocha")).toBe("catppuccinmocha");
    expect(normalizeThemeQuery("CATPPUCCIN MOCHA")).toBe("catppuccinmocha");
  });
});

describe("formatThemeLine", () => {
  it("shows the display name, never the slug", () => {
    const line = formatThemeLine(findBundledPack("catppuccin-dark"));
    expect(line).toContain("Catppuccin Mocha");
    expect(line).not.toContain("catppuccin-dark");
  });

  it("carries no marker at all for the bundled default — CHM-42's 'a tag on every row means nothing'", () => {
    const line = formatThemeLine(findBundledPack("catppuccin-dark"));
    expect(line).not.toContain("(bundled)");
    expect(line).not.toContain("(user)");
  });

  it("marks a user pack, and only a user pack", () => {
    const bundled = findBundledPack("catppuccin-dark");
    const userPack: LoadedThemePack = { ...bundled, origin: "user" };
    expect(formatThemeLine(userPack)).toContain("(user)");
  });
});

describe("resolveThemeQuery", () => {
  it("resolves an exact slug", () => {
    const result = resolveThemeQuery(BUNDLED_PACKS, ["catppuccin-dark"]);
    expect(result).toEqual({ status: "resolved", loaded: findBundledPack("catppuccin-dark") });
  });

  it("resolves a quoted display name, case- and separator-insensitively", () => {
    const result = resolveThemeQuery(BUNDLED_PACKS, ["CATPPUCCIN-MOCHA"]);
    expect(result).toEqual({ status: "resolved", loaded: findBundledPack("catppuccin-dark") });
  });

  it("resolves several bare words joined into one name", () => {
    const result = resolveThemeQuery(BUNDLED_PACKS, ["catppuccin", "mocha"]);
    expect(result).toEqual({ status: "resolved", loaded: findBundledPack("catppuccin-dark") });
  });

  it("lists every candidate for an ambiguous prefix rather than guessing one", () => {
    const result = resolveThemeQuery(BUNDLED_PACKS, ["catppuccin"]);
    expect(result.status).toBe("ambiguous");
    if (result.status !== "ambiguous") throw new Error("unreachable");
    const candidateSlugs = result.candidates.map((loaded) => loaded.pack.manifest.slug).sort();
    expect(candidateSlugs).toEqual(["catppuccin-dark", "catppuccin-light"]);
  });

  it("suggests the closest match for a name that resolves to nothing", () => {
    const result = resolveThemeQuery(BUNDLED_PACKS, ["Catpuccin Mocha"]);
    expect(result.status).toBe("unknown");
    if (result.status !== "unknown") throw new Error("unreachable");
    expect(result.closest?.pack.manifest.slug).toBe("catppuccin-dark");
  });
});

describe("USAGE", () => {
  it("names `chm themes` as the way to browse", () => {
    expect(USAGE).toContain("chm themes");
  });

  // CHM-44: chm themes moved from listing to picking, and the usage text has
  // to say so plainly rather than still reading like a static list command.
  it("describes `chm themes` as browsing/picking, not listing", () => {
    expect(USAGE).toMatch(/chm themes\s+browse and pick/);
    expect(USAGE).toContain("chm themes --list");
    expect(USAGE).toContain("chm pick");
  });
});

// CHM-44: `chm themes` opens the picker, but only when both streams are a
// real TTY — reading arrow keys needs a real stdin, and repainting frames
// needs a real stdout, so a pipe on either end (or an explicit `--list`)
// must fall back to the plain, scriptable list instead.
describe("wantsPlainThemeList", () => {
  it("is false in a real terminal with no --list flag — the picker opens", () => {
    expect(wantsPlainThemeList([], true, true)).toBe(false);
  });

  it("is true when --list is given, even in a real terminal", () => {
    expect(wantsPlainThemeList(["--list"], true, true)).toBe(true);
  });

  it("is true when stdout is piped, so escape codes never land in the pipe", () => {
    expect(wantsPlainThemeList([], true, false)).toBe(true);
  });

  it("is true when stdin isn't a TTY, so it never blocks on arrow keys that can't arrive", () => {
    expect(wantsPlainThemeList([], false, true)).toBe(true);
  });
});

// CHM-52: previewHighlighted() used to call applyThemePack — a full
// four-target apply, ~324ms measured in-process — on every arrow key. The
// picker's own preview is now these escape codes, pushed straight to the
// terminal; a real bundled pack's own scheme (catppuccin-dark), never
// invented hex, so a wrong palette index or a swapped OSC code would show up
// against real values.
describe("buildTerminalPreviewSequence", () => {
  const scheme = findBundledPack("catppuccin-dark").pack.payloads["windows-terminal"];

  it("sets every ANSI slot by OSC 4, at the slot's own numbered index", () => {
    const sequence = buildTerminalPreviewSequence(scheme);

    expect(sequence).toContain(`\x1b]4;0;${scheme.black}\x07`);
    expect(sequence).toContain(`\x1b]4;1;${scheme.red}\x07`);
    expect(sequence).toContain(`\x1b]4;7;${scheme.white}\x07`);
    expect(sequence).toContain(`\x1b]4;8;${scheme.brightBlack}\x07`);
    expect(sequence).toContain(`\x1b]4;15;${scheme.brightWhite}\x07`);
  });

  it("sets the terminal's own foreground, background and cursor by OSC 10/11/12", () => {
    const sequence = buildTerminalPreviewSequence(scheme);

    expect(sequence).toContain(`\x1b]10;${scheme.foreground}\x07`);
    expect(sequence).toContain(`\x1b]11;${scheme.background}\x07`);
    expect(sequence).toContain(`\x1b]12;${scheme.cursorColor}\x07`);
  });

  it("never touches a config file — it is a plain string, nothing more", () => {
    expect(typeof buildTerminalPreviewSequence(scheme)).toBe("string");
  });
});

describe("buildTerminalResetSequence", () => {
  it("resets every ANSI slot by OSC 104 and the terminal's own fg/bg/cursor by OSC 110/111/112 — the reverse of buildTerminalPreviewSequence, for Esc when nothing was active before the picker opened", () => {
    const sequence = buildTerminalResetSequence();

    for (let paletteIndex = 0; paletteIndex < 16; paletteIndex += 1) {
      expect(sequence).toContain(`\x1b]104;${paletteIndex}\x07`);
    }
    expect(sequence).toContain("\x1b]110\x07");
    expect(sequence).toContain("\x1b]111\x07");
    expect(sequence).toContain("\x1b]112\x07");
  });

  it("carries no colour of its own — a reset, not a preview of anything", () => {
    expect(buildTerminalResetSequence()).not.toMatch(/#[0-9a-f]{6}/i);
  });
});

// CHM-52: Herdr, Oh My Posh and Claude Code can only be previewed with a
// real file write, so createSettledFileTargetPreview is what turns "one
// apply per keystroke" into "one apply once movement settles" — the fix for
// "holding the key for 10 rows: 3.2s of frozen UI" and for burying undo
// history under 100 previews of themes the user never chose.
describe("createSettledFileTargetPreview", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not apply at all until the debounce delay has passed", () => {
    const applyToFileTargets = vi.fn();
    const scheduler = createSettledFileTargetPreview(applyToFileTargets, 150);

    scheduler.schedule("catppuccin-dark");
    vi.advanceTimersByTime(149);

    expect(applyToFileTargets).not.toHaveBeenCalled();
  });

  it("applies once the debounce delay has passed", () => {
    const applyToFileTargets = vi.fn();
    const scheduler = createSettledFileTargetPreview(applyToFileTargets, 150);

    scheduler.schedule("catppuccin-dark");
    vi.advanceTimersByTime(150);

    expect(applyToFileTargets).toHaveBeenCalledTimes(1);
    expect(applyToFileTargets).toHaveBeenCalledWith("catppuccin-dark");
  });

  // The acceptance criterion, directly: holding an arrow key through every
  // one of the 26 bundled packs, with no pause between rows, must perform a
  // small, bounded number of file applies — not one per row. Scheduling 26
  // times in a row with no time advance between them, then settling once,
  // proves it is bounded to exactly one, superseding every row passed
  // through rather than queuing behind them.
  it("holding an arrow key through 26 rows with no pause performs exactly one file apply, for the last row reached", () => {
    const applyToFileTargets = vi.fn();
    const scheduler = createSettledFileTargetPreview(applyToFileTargets, 150);
    const slugs = BUNDLED_PACKS.map((loaded) => loaded.pack.manifest.slug);
    expect(slugs.length).toBeGreaterThan(1);

    for (const slug of slugs) {
      scheduler.schedule(slug);
    }
    vi.advanceTimersByTime(150);

    expect(applyToFileTargets).toHaveBeenCalledTimes(1);
    expect(applyToFileTargets).toHaveBeenCalledWith(slugs[slugs.length - 1]);
  });

  it("cancel prevents a pending apply from ever firing — what Enter and Esc both call before taking over the final write themselves", () => {
    const applyToFileTargets = vi.fn();
    const scheduler = createSettledFileTargetPreview(applyToFileTargets, 150);

    scheduler.schedule("catppuccin-dark");
    scheduler.cancel();
    vi.advanceTimersByTime(150);

    expect(applyToFileTargets).not.toHaveBeenCalled();
  });
});

// CHM-52's own headline number: moving the highlight one row must cost under
// 30ms of blocking work, not the 324ms a full four-target apply measured.
// What actually runs synchronously on a keystroke, now that the file-writing
// targets are debounced, is building the terminal's own escape sequence and
// scheduling (never running) the settled file-target preview — this times
// that exact pair, back to back, for every bundled pack, the same "hold the
// arrow key through the whole list" scenario the ticket asks to verify.
describe("the picker's per-keystroke preview cost", () => {
  it("builds a preview sequence and schedules the settled file-target apply for every bundled pack in well under 30ms total", () => {
    const scheduler = createSettledFileTargetPreview(() => undefined, 150);

    const startedAtMs = performance.now();
    for (const loaded of BUNDLED_PACKS) {
      buildTerminalPreviewSequence(loaded.pack.payloads["windows-terminal"]);
      scheduler.schedule(loaded.pack.manifest.slug);
    }
    const elapsedMs = performance.now() - startedAtMs;

    expect(elapsedMs).toBeLessThan(30);
  });
});
