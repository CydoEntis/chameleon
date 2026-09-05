import { z } from "zod";
import { MUTED_MIN_RATIO, ROLES, TEXT_MIN_RATIO, type Role } from "../constants.js";
import { contrastRatio } from "./color.js";
import { toPalette, type Appearance } from "./palette.js";
import { repairFailingRoles } from "./repair.js";
import { assignRolesByContrast } from "./roles.js";
import { resolveSelectionAndBody } from "./selection.js";
import { SchemeSchema, type Scheme } from "./scheme.js";

/**
 * Where a bundled pack's source scheme came from, carried through to the
 * shipped pack so attribution and licence travel with the colours rather
 * than living only in a vendor directory that never ships — see CLAUDE.md's
 * "Attribution and the upstream MIT licence ship with the packs".
 */
export interface PackAttribution {
  readonly source: string;
  readonly sourceUrl: string;
  readonly commit: string;
  readonly license: string;
}

/**
 * Everything about a pack that is not colour: identity, grouping and
 * provenance. Attribution is optional because it names an *upstream*
 * source — every bundled pack has one (see PackAttribution above), but a
 * pack a user drops into their own theme directory adapts a scheme of
 * their own choosing and owes no attribution to Chameleon.
 */
export interface ThemePackManifest {
  readonly slug: string;
  readonly name: string;
  readonly family: string;
  readonly appearance: Appearance;
  readonly attribution?: PackAttribution | undefined;
}

/**
 * The colour data every target needs to theme itself, computed once at
 * build time. windows-terminal's payload is the scheme's own 20 slots,
 * verbatim, apart from `selectionBackground` — resolved against ground and
 * body once, the same resolution herdr's `selection_bg` reuses, so the two
 * targets can never disagree about what selection is (see CHM-30's
 * resolveSelectionAndBody). oh-my-posh and herdr's payload is the resolved,
 * repaired role table those adapters key their own blocks off. Every
 * adapter's apply() still takes a Scheme and derives what it needs itself —
 * see adapters/*.ts — so this is a precomputed, build-time-checkable copy of
 * exactly what apply() would derive live, not a second source of truth:
 * assignRolesByContrast, repairFailingRoles and resolveSelectionAndBody are
 * all pure, so the two can never disagree.
 */
export interface ThemePackPayloads {
  readonly "windows-terminal": Scheme;
  readonly "oh-my-posh": Readonly<Record<Role, string>>;
  readonly herdr: Readonly<Record<Role, string>> & { readonly selection_bg: string };
}

export interface ThemePack {
  readonly manifest: ThemePackManifest;
  readonly payloads: ThemePackPayloads;
}

/**
 * Lowercase, hyphen-separated identifier for a pack — the file name it
 * ships under and the token `ch <slug>` will match against. Diacritics are
 * stripped rather than dropped, so "Rosé Pine" slugs to "rose-pine-dark",
 * not "ros-pine-dark".
 */
function toSlug(family: string, appearance: Appearance): string {
  const asciiFamily = family.normalize("NFD").replace(/[̀-ͯ]/g, "");
  const familySlug = asciiFamily
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${familySlug}-${appearance}`;
}

function roleHexTable(resolvedPalette: ReturnType<typeof repairFailingRoles>["palette"]): Record<Role, string> {
  const table = {} as Record<Role, string>;
  for (const role of ROLES) table[role] = resolvedPalette[role].hex;
  return table;
}

/** Every role but ground itself is measured against ground and must clear a floor. */
const TEXT_AND_MUTED_ROLES = ROLES.filter((role) => role !== "ground");

/**
 * Fails loudly if a resolved role does not actually clear its floor. Repair
 * is expected to guarantee this already — this is the build-time gate that
 * makes "none ships failing a floor" (CLAUDE.md) a checked fact rather than
 * a claim about what repair.ts is supposed to do.
 */
function assertRoleClearsFloor(role: Role, hex: string, groundHex: string, schemeName: string): void {
  const ratio = contrastRatio(hex, groundHex);
  const floor = role === "muted" ? MUTED_MIN_RATIO : TEXT_MIN_RATIO;
  if (ratio < floor) {
    throw new Error(
      `"${schemeName}" role "${role}" measures ${ratio.toFixed(2)} against ground, below its floor of ${floor}`,
    );
  }
}

/**
 * Fails loudly if a resolved selection cannot be read under body text — the
 * one guarantee resolveSelectionAndBody always keeps, even on the pack
 * where ground and body leave no colour able to also clear
 * SELECTION_MIN_VISIBLE_RATIO against ground (see its own doc comment).
 * Mirrors assertRoleClearsFloor: a build-time gate on what the resolver is
 * expected to guarantee, not a second repair attempt.
 */
function assertSelectionReadableUnderBody(selectionHex: string, bodyHex: string, schemeName: string): void {
  const ratio = contrastRatio(bodyHex, selectionHex);
  if (ratio < TEXT_MIN_RATIO) {
    throw new Error(
      `"${schemeName}" selection measures ${ratio.toFixed(2)} for body-on-selection, below its floor of ${TEXT_MIN_RATIO}`,
    );
  }
}

/**
 * Runs a scheme through the full contrast engine — assign, then repair —
 * and packages the result as a shippable pack: a manifest carrying identity
 * and attribution, plus every target's payload. Pure: no file I/O, so the
 * build tool that generates the bundled packs, the loader that reads a
 * user's dropped-in pack, and any test can all call it directly against a
 * scheme literal. `attribution` is omitted for a user pack, which has no
 * upstream to credit — see ThemePackManifest.
 *
 * `explicitSlug`, when given, is used verbatim instead of the slug derived
 * from `family` and the measured appearance. This is what lets a dropped-in
 * pack's declared slug collide with a bundled pack's on purpose, so it can
 * override it — see CLAUDE.md: "A manifest's declared slug is what the pack
 * loads as. Never derive it from name when one is declared."
 */
export function buildThemePack(
  scheme: Scheme,
  family: string,
  attribution?: PackAttribution,
  explicitSlug?: string,
): ThemePack {
  const measured = toPalette(scheme);
  const { palette: resolvedPalette } = repairFailingRoles(assignRolesByContrast(measured));

  for (const role of TEXT_AND_MUTED_ROLES) {
    assertRoleClearsFloor(role, resolvedPalette[role].hex, resolvedPalette.ground.hex, scheme.name);
  }

  // Resolved once, from the roles every other target already keys off, so
  // Windows Terminal and Herdr — the only two targets a selection actually
  // paints behind — can never disagree about what it is. See CHM-30's
  // resolveSelectionAndBody for the rule and ThemePackPayloads for why this
  // is the one case herdr's own role table can differ from oh-my-posh's.
  const { selection, body } = resolveSelectionAndBody(scheme.selectionBackground, resolvedPalette.ground.hex, resolvedPalette.body.hex);
  assertSelectionReadableUnderBody(selection.hex, body.hex, scheme.name);

  const roleHexes = roleHexTable(resolvedPalette);
  const herdrRoleHexes = { ...roleHexes, body: body.hex };

  return {
    manifest: {
      slug: explicitSlug ?? toSlug(family, measured.appearance),
      name: scheme.name,
      family,
      appearance: measured.appearance,
      ...(attribution !== undefined ? { attribution } : {}),
    },
    payloads: {
      "windows-terminal": { ...scheme, selectionBackground: selection.hex },
      "oh-my-posh": roleHexes,
      herdr: { ...herdrRoleHexes, selection_bg: selection.hex },
    },
  };
}

const hexColor = z.string().regex(/^#[0-9a-f]{6}$/i, "must be a 6-digit hex colour");
const RoleHexTableSchema = z.object({
  ground: hexColor,
  body: hexColor,
  accent: hexColor,
  muted: hexColor,
  success: hexColor,
  error: hexColor,
});

/**
 * Validates a shipped pack file's shape at load time. The packs under
 * themes/ are generated and committed by this project, never user-edited,
 * but they still cross a file-system boundary into the running CLI — see
 * code-standards.md, "Validate at every boundary" — so a corrupted or
 * hand-edited pack file fails with a named reason instead of a crash deep
 * inside an adapter.
 */
export const ThemePackSchema = z.object({
  manifest: z.object({
    slug: z.string().min(1),
    name: z.string().min(1),
    family: z.string().min(1),
    appearance: z.enum(["light", "dark"]),
    attribution: z
      .object({
        source: z.string().min(1),
        sourceUrl: z.string().min(1),
        commit: z.string().min(1),
        license: z.string().min(1),
      })
      .optional(),
  }),
  payloads: z.object({
    "windows-terminal": SchemeSchema,
    "oh-my-posh": RoleHexTableSchema,
    herdr: RoleHexTableSchema.extend({ selection_bg: hexColor }),
  }),
});

/** Parses a shipped pack's raw JSON, naming the file whose shape is wrong rather than throwing a bare ZodError. */
export function parseThemePack(input: unknown, fileName: string): ThemePack {
  const result = ThemePackSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`theme pack "${fileName}" is malformed: ${result.error.message}`);
  }
  return result.data;
}

/**
 * What a user hand-writes in a dropped-in pack's pack.json: the one scheme
 * it adapts, plus an optional family for grouping it with a light/dark
 * sibling of its own, and an optional slug.
 *
 * `slug` is optional in the *file*, but never silently defaulted past this
 * point — a manifest that omits it must still get one, and the caller that
 * derives it is responsible for warning that it did (see
 * adapters/user-theme-packs.ts). When a manifest does declare a slug, it is
 * load-bearing: it is what a user pack collides on to override a bundled
 * pack of the same slug, and CHM-12 shipped a version of this loader that
 * silently discarded a declared slug in favour of one derived from `family`,
 * which made overriding a bundled pack impossible by construction.
 */
export const UserPackManifestSchema = z.object({
  slug: z.string().min(1).optional(),
  family: z.string().min(1).optional(),
  scheme: SchemeSchema,
});

export type UserPackManifest = z.infer<typeof UserPackManifestSchema>;

/**
 * Parses a dropped-in pack's pack.json, naming the pack directory whose
 * shape is wrong rather than throwing a bare ZodError — the same
 * name-the-source contract as parseThemePack, but keyed by directory name
 * rather than file name since a user pack is a directory of its own.
 */
export function parseUserPackManifest(input: unknown, packDirName: string): UserPackManifest {
  const result = UserPackManifestSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`user pack "${packDirName}" is malformed: ${result.error.message}`);
  }
  return result.data;
}
