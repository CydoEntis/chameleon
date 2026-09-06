/**
 * `chm doctor`'s own contrast check (CHM-79): measures the exact same
 * declared inventory theme-pack.ts's build-time gate runs over the 29
 * bundled packs (see palette/surfaces.ts), but against whichever config
 * files are actually sitting on this machine right now. The build-time gate
 * proves a pack ships legible; this proves it is *still* legible on a real
 * machine, after real hand-edits, real partial applies and real drift
 * (CHM-27) — a pack could ship every pair clearing its floor and a config a
 * user then edited by hand could still fail one of them. Read-only: nothing
 * here writes or repairs, it only measures and names what fails.
 */

import { createDefaultOhMyPoshAdapter, repairSegmentForegrounds } from "./adapters/oh-my-posh.js";
import { createHerdrAdapter } from "./adapters/herdr.js";
import { createWindowsTerminalAdapter } from "./adapters/windows-terminal.js";
import {
  checkContrastPairs,
  herdrContrastPairs,
  windowsTerminalContrastPairs,
  type ContrastFailure,
  type HerdrTokenSet,
} from "./palette/surfaces.js";
import { SchemeSchema, type Scheme } from "./palette/scheme.js";

/**
 * One target's own share of `chm doctor`'s contrast findings. Undefined
 * means "nothing to report for this target" — not installed, its config
 * could not be read, or (windows-terminal) the currently-applied scheme is
 * not one this inventory can measure — never "clean": a target that is
 * actually clean reports an empty array, so the two are never confused.
 */
export interface DoctorContrastReport {
  readonly herdr: readonly ContrastFailure[] | undefined;
  readonly windowsTerminal: readonly ContrastFailure[] | undefined;
  /**
   * Oh My Posh has no per-pack inventory to measure against — its pairs
   * depend on whichever segments and backgrounds a user's own prompt
   * defines, not on a pack (see this ticket's own body). This reuses
   * repairSegmentForegrounds (CHM-40), the exact measurement `chm`'s own
   * apply already runs, rather than duplicating it — each entry names the
   * palette key that needed a repaired foreground to clear TEXT_MIN_RATIO
   * against its own segment background(s).
   */
  readonly ohMyPosh: readonly string[] | undefined;
}

/**
 * `custom` — Herdr's own live [theme.custom] table — as a HerdrTokenSet, or
 * undefined when it is missing one of the tokens herdrContrastPairs actually
 * reads (see palette/surfaces.ts). A config missing one of these belongs to
 * a config Chameleon never fully themed, or one hand-edited since, and is
 * reported as "nothing to check" rather than guessed at. Built field by
 * field, rather than asserted with a cast, so a config missing a token is
 * caught by the type checker narrowing each one, not by trusting the
 * table's own shape.
 */
function herdrTokenSetFrom(custom: Readonly<Record<string, string>>): HerdrTokenSet | undefined {
  const { sidebar_bg, panel_bg, active_row_bg, selection_bg, text, subtext0, overlay0, accent, green, red, yellow, blue, teal, mauve, peach } = custom;
  if (
    sidebar_bg === undefined ||
    panel_bg === undefined ||
    active_row_bg === undefined ||
    selection_bg === undefined ||
    text === undefined ||
    subtext0 === undefined ||
    overlay0 === undefined ||
    accent === undefined ||
    green === undefined ||
    red === undefined ||
    yellow === undefined ||
    blue === undefined ||
    teal === undefined ||
    mauve === undefined ||
    peach === undefined
  ) {
    return undefined;
  }
  return { sidebar_bg, panel_bg, active_row_bg, selection_bg, text, subtext0, overlay0, accent, green, red, yellow, blue, teal, mauve, peach };
}

/**
 * Herdr's own live contrast failures, or undefined when Herdr is not
 * installed, its config.toml cannot be read, or it has never been fully
 * themed by Chameleon (see herdrTokenSetFrom) — never thrown: a doctor
 * command must survive a config it cannot make sense of, the same
 * "detect, never crash" contract every other doctor check already holds.
 */
function checkHerdrContrastLive(): readonly ContrastFailure[] | undefined {
  try {
    const adapter = createHerdrAdapter();
    if (!adapter.detect()) return undefined;
    const tokens = herdrTokenSetFrom(adapter.read().theme.custom);
    if (!tokens) return undefined;
    return checkContrastPairs(herdrContrastPairs(tokens));
  } catch {
    return undefined;
  }
}

/** The raw `schemes[]` entry whose own `name` matches `activeSchemeName`, parsed and validated — undefined when there is no match or it fails validation, rather than measuring a scheme this adapter would itself refuse to trust. */
function activeWindowsTerminalScheme(schemes: readonly unknown[] | undefined, activeSchemeName: unknown): Scheme | undefined {
  const rawScheme = schemes?.find(
    (entry) => typeof entry === "object" && entry !== null && (entry as Record<string, unknown>)["name"] === activeSchemeName,
  );
  const parsed = SchemeSchema.safeParse(rawScheme);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Windows Terminal's own live contrast failures, measured against whichever
 * scheme `profiles.defaults.colorScheme` currently names — or undefined when
 * Windows Terminal is not installed, its settings.json cannot be read, or
 * the active scheme cannot be found in schemes[] at all.
 */
function checkWindowsTerminalContrastLive(): readonly ContrastFailure[] | undefined {
  try {
    const adapter = createWindowsTerminalAdapter();
    if (!adapter.detect()) return undefined;
    const settings = adapter.read();
    const activeScheme = activeWindowsTerminalScheme(settings.schemes, settings.profiles?.defaults?.["colorScheme"]);
    if (!activeScheme) return undefined;
    return checkContrastPairs(windowsTerminalContrastPairs(activeScheme));
  } catch {
    return undefined;
  }
}

/**
 * Oh My Posh's own live contrast failures — see DoctorContrastReport's own
 * doc comment for why this reuses repairSegmentForegrounds rather than
 * declaring a separate inventory.
 */
function checkOhMyPoshContrastLive(): readonly string[] | undefined {
  try {
    const adapter = createDefaultOhMyPoshAdapter();
    if (!adapter.detect()) return undefined;
    const config = adapter.read();
    const { additionalPaletteEntries } = repairSegmentForegrounds(config.blocks ?? [], config.palette ?? {});
    return Object.keys(additionalPaletteEntries).map(
      (overrideKey) => `oh-my-posh: a segment's own foreground needed "${overrideKey}" — its source key fails TEXT_MIN_RATIO against that segment's own background`,
    );
  } catch {
    return undefined;
  }
}

/**
 * Runs CHM-79's own contrast gate against this machine's real config files —
 * `chm doctor`'s "does swapping a theme actually leave everything readable
 * and every highlight detectable" check, for whichever targets are
 * installed and themed right now.
 */
export function checkLiveContrastInventory(): DoctorContrastReport {
  return {
    herdr: checkHerdrContrastLive(),
    windowsTerminal: checkWindowsTerminalContrastLive(),
    ohMyPosh: checkOhMyPoshContrastLive(),
  };
}
