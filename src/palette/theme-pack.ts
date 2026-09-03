import { z } from "zod";
import { MUTED_MIN_RATIO, ROLES, TEXT_MIN_RATIO, type Role } from "../constants.js";
import { contrastRatio } from "./color.js";
import { toPalette, type Appearance } from "./palette.js";
import { repairFailingRoles } from "./repair.js";
import { assignRolesByContrast } from "./roles.js";
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

/** Everything about a pack that is not colour: identity, grouping and provenance. */
export interface ThemePackManifest {
  readonly slug: string;
  readonly name: string;
  readonly family: string;
  readonly appearance: Appearance;
  readonly attribution: PackAttribution;
}

/**
 * The colour data every target needs to theme itself, computed once at
 * build time. windows-terminal's payload is the raw Scheme because that
 * adapter's apply() writes a scheme's own 20 slots verbatim into
 * schemes[]; oh-my-posh and herdr's payload is the resolved, repaired role
 * table those adapters key their own blocks off. Every adapter's apply()
 * still takes a Scheme and derives what it needs itself — see
 * adapters/*.ts — so this is a precomputed, build-time-checkable copy of
 * exactly what apply() would derive live, not a second source of truth:
 * assignRolesByContrast and repairFailingRoles are pure, so the two can
 * never disagree.
 */
export interface ThemePackPayloads {
  readonly "windows-terminal": Scheme;
  readonly "oh-my-posh": Readonly<Record<Role, string>>;
  readonly herdr: Readonly<Record<Role, string>>;
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
 * Runs a scheme through the full contrast engine — assign, then repair —
 * and packages the result as a shippable pack: a manifest carrying identity
 * and attribution, plus every target's payload. Pure: no file I/O, so the
 * build tool that generates the bundled packs and any future test can call
 * it directly against a scheme literal.
 */
export function buildThemePack(scheme: Scheme, family: string, attribution: PackAttribution): ThemePack {
  const measured = toPalette(scheme);
  const { palette: resolvedPalette } = repairFailingRoles(assignRolesByContrast(measured));

  for (const role of TEXT_AND_MUTED_ROLES) {
    assertRoleClearsFloor(role, resolvedPalette[role].hex, resolvedPalette.ground.hex, scheme.name);
  }

  const roleHexes = roleHexTable(resolvedPalette);

  return {
    manifest: {
      slug: toSlug(family, measured.appearance),
      name: scheme.name,
      family,
      appearance: measured.appearance,
      attribution,
    },
    payloads: {
      "windows-terminal": scheme,
      "oh-my-posh": roleHexes,
      herdr: roleHexes,
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
    attribution: z.object({
      source: z.string().min(1),
      sourceUrl: z.string().min(1),
      commit: z.string().min(1),
      license: z.string().min(1),
    }),
  }),
  payloads: z.object({
    "windows-terminal": SchemeSchema,
    "oh-my-posh": RoleHexTableSchema,
    herdr: RoleHexTableSchema,
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
