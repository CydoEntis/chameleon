import { z } from "zod";
import { isKnownRole, TEXT_MIN_RATIO, type Role } from "../constants.js";
import { contrastRatio } from "./color.js";

/**
 * CHM-46: a prompt pack is authored against Chameleon's own six roles rather
 * than a stranger's arbitrary palette (see CLAUDE.md's three-word model), so
 * repainting it never touches the reverse-engineering path that produced
 * CHM-31, CHM-37, CHM-40 and CHM-43. Every colour reference in a bundled
 * `.omp.json` is `p:<role>`; nothing here is a hex literal.
 */
const PALETTE_REF_PREFIX = "p:";

/** Everything about a bundled prompt that is not colour: identity and whether it needs a Nerd Font to render its glyphs. Kept deliberately smaller than ThemePackManifest — a prompt pack owes no per-pack attribution of its own; see prompts/ATTRIBUTION.md for the shared, once-per-file credit. */
export const PromptPackManifestSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  requiresNerdFont: z.boolean(),
});

export type PromptPackManifest = z.infer<typeof PromptPackManifestSchema>;

/**
 * The slice of a bundled `.omp.json` this module actually reasons about.
 * Deliberately narrower than the adapter's own OhMyPoshConfigSchema
 * (oh-my-posh.ts): a bundled layout is authored by hand, never edited by a
 * user, so there is no need to tolerate the arbitrary shapes a stranger's
 * config can take — only to lint the one shape Chameleon itself writes.
 * `foreground`/`background` are read as plain strings, never
 * `*_templates` arrays: no bundled layout uses a conditional colour, so
 * there is nothing for this schema to tolerate there either.
 */
const PromptSegmentSchema = z
  .object({
    foreground: z.string().optional(),
    background: z.string().optional(),
  })
  .catchall(z.unknown());

const PromptBlockSchema = z
  .object({
    segments: z.array(PromptSegmentSchema).optional(),
  })
  .catchall(z.unknown());

export const PromptLayoutSchema = z
  .object({
    blocks: z.array(PromptBlockSchema),
  })
  .catchall(z.unknown());

export type PromptLayout = z.infer<typeof PromptLayoutSchema>;
export type PromptSegment = z.infer<typeof PromptSegmentSchema>;

/** Parses a bundled layout's raw JSON, naming the file whose shape is wrong rather than throwing a bare ZodError — the same contract as theme-pack.ts's parseThemePack. */
export function parsePromptLayout(rawJson: unknown, fileName: string): PromptLayout {
  const result = PromptLayoutSchema.safeParse(rawJson);
  if (!result.success) {
    throw new Error(`prompt layout "${fileName}" is malformed: ${result.error.message}`);
  }
  return result.data;
}

/** Every segment across every block, in document order — the flat list every lint and contrast check below walks. A block with no `segments` array contributes none, rather than failing: a bundled layout's own blocks are always written with one, but this stays permissive the way segmentsOf (oh-my-posh.ts) is for a user's config. */
function allSegments(layout: PromptLayout): readonly PromptSegment[] {
  return layout.blocks.flatMap((block) => block.segments ?? []);
}

/** The role `fieldValue` names, or undefined when it is missing, not a `p:` reference, or names something other than one of Chameleon's six roles. Never a literal colour: findLiteralHexColors is what rejects those, so a caller here can assume anything reaching it that is not a role reference is already a separate, reported defect. */
function roleReferencedBy(fieldValue: string | undefined): Role | undefined {
  if (fieldValue === undefined || !fieldValue.startsWith(PALETTE_REF_PREFIX)) return undefined;
  const candidateRole = fieldValue.slice(PALETTE_REF_PREFIX.length);
  return isKnownRole(candidateRole) ? candidateRole : undefined;
}

/** Every hex colour literal anywhere in `layoutText`, deduplicated — CLAUDE.md's "Never ship a colour that fails its contrast floor" only holds if nothing in a bundled layout can bypass repair with a colour of its own. Scans the raw text rather than the parsed structure, since a stray hex belongs nowhere in a bundled layout at all, not only in `foreground`/`background`. */
export function findLiteralHexColors(layoutText: string): string[] {
  const matches = layoutText.match(/#[0-9a-fA-F]{6}\b/g) ?? [];
  return [...new Set(matches)];
}

/**
 * The Unicode Private Use Area every Nerd Font glyph this project's bundled
 * layouts draw from is assigned in — every codepoint used across lambda,
 * spaceship, avit, di4am0nd and bubblesline falls in this one BMP range.
 * half-life's own acceptance criterion ("renders with no Nerd Font glyphs at
 * all") is checked against this, not against non-ASCII in general: a
 * layout's `template` fields are Go template syntax and ordinary
 * punctuation, which this must not flag.
 */
const NERD_FONT_GLYPH_PATTERN = /[\uE000-\uF8FF]/gu;

/** Every Nerd Font glyph codepoint anywhere in `layoutText`, deduplicated. Empty for a layout that renders with no Nerd Font at all — see half-life's own manifest, requiresNerdFont: false. */
export function findNerdFontGlyphs(layoutText: string): string[] {
  const matches = layoutText.match(NERD_FONT_GLYPH_PATTERN) ?? [];
  return [...new Set(matches)];
}

/**
 * One segment's own foreground/background pair, resolved to roles — or the
 * reason it could not be. A segment with no background renders on the
 * terminal's own background, which is ground by definition, so `undefined`
 * here means "ground", never "unchecked" — see CLAUDE.md's "GOOD foreground
 * p:accent, no background".
 */
interface SegmentRolePair {
  readonly foregroundRole: Role | undefined;
  readonly backgroundRole: Role | undefined;
  /** Set when a `foreground`/`background` field is present but is not a resolvable `p:<role>` reference — the shape a hand-broken fixture takes, and the one findLiteralHexColors does not already cover (a colour *name*, or a role that does not exist). */
  readonly unresolvedFieldNames: readonly string[];
}

function segmentRolePairOf(segment: PromptSegment): SegmentRolePair {
  const unresolvedFieldNames: string[] = [];
  if (segment.foreground !== undefined && roleReferencedBy(segment.foreground) === undefined) unresolvedFieldNames.push("foreground");
  if (segment.background !== undefined && roleReferencedBy(segment.background) === undefined) unresolvedFieldNames.push("background");

  return {
    foregroundRole: roleReferencedBy(segment.foreground),
    backgroundRole: roleReferencedBy(segment.background),
    unresolvedFieldNames,
  };
}

/**
 * Every reason `layout`'s own segments are not safe to ship, named per
 * segment so a broken fixture (or a broken hand-authored layout) fails with
 * something a person can act on rather than a bare boolean. Two kinds of
 * defect, per CHM-46's authoring rule:
 *
 * - a `foreground`/`background` field that is present but not a `p:<role>`
 *   reference at all (a typo, an unknown role, a colour name);
 * - a segment naming both a foreground and a background role where neither
 *   one is `ground` — CLAUDE.md's "One side of every foreground/background
 *   pair must be ground", the rule that keeps a segment out of the unsafe
 *   region measured across all 26 bundled packs (body-vs-accent as low as
 *   1.00 on Solarized Dark).
 *
 * A segment with only a foreground (no background at all) is never flagged
 * here: it renders on the terminal's own background, which is ground.
 */
export function findGroundPairingViolations(layout: PromptLayout): string[] {
  return allSegments(layout).flatMap((segment, index) => {
    const { foregroundRole, backgroundRole, unresolvedFieldNames } = segmentRolePairOf(segment);
    if (unresolvedFieldNames.length > 0) {
      return [`segment ${index}: ${unresolvedFieldNames.join(", ")} is not a "p:<role>" reference`];
    }
    if (backgroundRole === undefined) return [];

    const isGroundPaired = foregroundRole === "ground" || backgroundRole === "ground";
    return isGroundPaired ? [] : [`segment ${index}: foreground "${foregroundRole}" and background "${backgroundRole}" — neither is ground`];
  });
}

/** Every reason `layoutText` must not ship, combining both guarantees CLAUDE.md names for a bundled prompt: no literal hex, and every segment ground-paired. Pure and total — never throws, so a caller (a test, or the build-time lint) decides what "must not ship" means for it. */
export function lintPromptLayout(layoutText: string, fileName: string): string[] {
  const layout = parsePromptLayout(JSON.parse(layoutText), fileName);
  const hexViolations = findLiteralHexColors(layoutText).map((hex) => `literal hex colour ${hex}`);
  return [...hexViolations, ...findGroundPairingViolations(layout)];
}

/** Throws, naming `fileName` and every violation, when `layoutText` fails lintPromptLayout — the build-time gate CLAUDE.md's "A bad layout must not be able to ship" needs to be a checked fact. */
export function assertPromptLayoutIsSafe(layoutText: string, fileName: string): void {
  const violations = lintPromptLayout(layoutText, fileName);
  if (violations.length > 0) {
    throw new Error(`prompt layout "${fileName}" is not safe to ship:\n${violations.map((violation) => `  - ${violation}`).join("\n")}`);
  }
}

/** Every segment `layout` carries, counted once each — the denominator CHM-46's own acceptance criterion asks for: "assert the count of segments checked", so a contrast test that silently checked zero segments (CHM-40's own failure mode: a single-sample check) fails loudly instead of passing for the wrong reason. */
export function countSegments(layout: PromptLayout): number {
  return allSegments(layout).length;
}

/** One segment's own foreground-against-background contrast, measured against `roleHexes` — a specific pack's own resolved, repaired six roles (ThemePackPayloads["oh-my-posh"]). A segment with no background is measured against ground, per segmentRolePairOf's own contract. Undefined when the segment carries no resolvable foreground role at all, which findGroundPairingViolations has already separately reported — this never re-reports it. */
function segmentContrastRatio(segment: PromptSegment, roleHexes: Readonly<Record<Role, string>>): number | undefined {
  const { foregroundRole, backgroundRole } = segmentRolePairOf(segment);
  if (foregroundRole === undefined) return undefined;
  return contrastRatio(roleHexes[foregroundRole], roleHexes[backgroundRole ?? "ground"]);
}

/** Every segment in `layout` whose foreground-against-background contrast, measured against `roleHexes`, falls below TEXT_MIN_RATIO — CHM-46's own acceptance criterion, checked per pack rather than assumed from the authoring rule alone. Named per segment index, the same as findGroundPairingViolations, so a failure names exactly which segment and which pack. */
export function findContrastFailures(layout: PromptLayout, roleHexes: Readonly<Record<Role, string>>, packSlug: string): string[] {
  return allSegments(layout).flatMap((segment, index) => {
    const ratio = segmentContrastRatio(segment, roleHexes);
    if (ratio === undefined || ratio >= TEXT_MIN_RATIO) return [];
    return [`${packSlug}: segment ${index} measures ${ratio.toFixed(2)}, below ${TEXT_MIN_RATIO}`];
  });
}

// --- Switching a bundled layout in (CHM-47) ---------------------------------
//
// A bundled layout is authored entirely against `p:<role>` references (see
// PALETTE_REF_PREFIX above) — this is the one step that turns it into an
// actual Oh My Posh config, by resolving every one of those references
// against a specific theme's own resolved roles. Pure, like everything else
// in this file: the adapter (adapters/oh-my-posh.ts) is what writes the
// result to Chameleon's own config file and repoints the pointer at it,
// never touching the user's own .omp.json — see CLAUDE.md's "Never rewrite
// a config file wholesale."

/** `value` with every `p:<role>` string reference replaced by its hex from `roleHexes`, walking arrays and plain objects recursively — every field a resolved config carries, not only a segment's own foreground/background, so a block-level or top-level property referencing a role (should a future layout ever need one) resolves exactly the same way. Anything that is not a role reference — a number, a boolean, an ordinary string, `null` — is returned untouched. */
function resolvedValueFor(value: unknown, roleHexes: Readonly<Record<Role, string>>): unknown {
  if (typeof value === "string") {
    const role = roleReferencedBy(value);
    return role !== undefined ? roleHexes[role] : value;
  }
  if (Array.isArray(value)) return value.map((item) => resolvedValueFor(item, roleHexes));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, fieldValue]) => [key, resolvedValueFor(fieldValue, roleHexes)]));
  }
  return value;
}

/**
 * `layout` with every `p:<role>` reference resolved against `roleHexes` —
 * the moment a bundled prompt pack becomes an Oh My Posh config Oh My Posh
 * itself can render. `roleHexes` is a specific theme pack's own resolved
 * "oh-my-posh" payload (ThemePackPayloads["oh-my-posh"]), so the same
 * layout paints differently under every theme, the whole point of CHM-46's
 * "any theme paints them for free". Pure — no file I/O — so this stays
 * testable against fixtures the same way every other palette/ module is.
 */
export function resolvePromptLayoutRoleReferences(
  layout: PromptLayout,
  roleHexes: Readonly<Record<Role, string>>,
): Record<string, unknown> {
  return resolvedValueFor(layout, roleHexes) as Record<string, unknown>;
}
