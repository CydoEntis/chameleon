/**
 * Recolours a palette key Chameleon does not own into the new theme's own
 * colour space, so an adapter can retint that key instead of deleting it or
 * flattening it. See CHM-31: Oh My Posh's palette table used to be replaced
 * wholesale with Chameleon's own six role names, deleting every key a real
 * prompt's segments referenced. See CHM-37: the fix for that, mapping every
 * key onto one of six roles, was still wrong — 46 of a real 47-key prompt
 * palette landed on the same three or four role colours, so the prompt
 * still rendered as flat, illegible blobs. See CHM-53: the fix for *that*
 * overcorrected the other way — carrying a key's own hue and chroma through
 * unchanged reproduced the source theme so faithfully that the destination
 * theme barely participated; four unrelated destination packs rendered the
 * same Solarized olive/gold/blue a user's config started with. What a
 * palette's keys are for is the relationships between them, not the literal
 * colours — those belong to whichever theme is active.
 *
 * See CHM-90: that reasoning holds only for a key a theme author actually
 * named. CHM-74's literal-hex lift mints a key with no relationship to
 * protect at all — recoloredHexFor's own hue-family retint left one
 * permanently red, or teal, under every pack it was ever applied to, which
 * is the opposite of what retinting is for. recoloredLiteralHexFor is the
 * lift's own recolour path: a full snap onto the destination pack's own
 * role colours, never a hue-family retint.
 */
import { ANSI_MIN_RATIO, GREEN_HUE_MAX_DEGREES, GREEN_HUE_MIN_DEGREES, MIN_REPAIRED_CHROMA, RED_HUE_MAX_DEGREES, RED_HUE_WRAP_MIN_DEGREES, } from "../constants.js";
import { chromaOf, contrastRatio, fromHueChromaMatch, hueDistanceDegrees, relativeLuminance, toHsl } from "./color.js";
import { matchValueForLuminance, poleWithMoreHeadroom } from "./repair.js";
import { ANSI_SLOT_NAMES } from "./ansi.js";
import { BASE_COLOR_SLOTS, hueCategoryOf } from "./roles.js";
/**
 * Name fragments reliable enough to pick a role without looking at the
 * key's colour at all — an "error" or "success" segment colour almost never
 * means anything else, unlike a bare hue a theme author could have picked
 * for decoration. Checked before retintByLuminance below.
 */
const ERROR_NAME_PATTERN = /error|fail/i;
const SUCCESS_NAME_PATTERN = /success/i;
/**
 * The role `name` announces outright, or undefined when it carries no such
 * signal — the common case, recoloured by retintByLuminance instead.
 */
function roleImpliedByName(name) {
    if (ERROR_NAME_PATTERN.test(name))
        return "error";
    if (SUCCESS_NAME_PATTERN.test(name))
        return "success";
    return undefined;
}
/**
 * The hue of whichever of the destination scheme's own base ANSI colours
 * measures closest to `sourceHue` — never the slot sharing the source key's
 * own name or hue category, for the same reason role assignment never
 * trusts a slot's name over what it measures (roles.ts: Rosé Pine Dawn's
 * `green` slot measures as a blue). This is what CHM-53 means by
 * "re-express using the target pack's colours for that family": the six
 * base slots (BASE_COLOR_SLOTS) are the only hue-bearing colours a theme
 * actually ships, so the nearest of those six *is* the family, for both the
 * source key and the destination alike.
 */
function nearestHueFamilyHue(sourceHue, targetScheme) {
    const candidateHues = BASE_COLOR_SLOTS.map((slot) => toHsl(targetScheme[slot]).hue);
    return candidateHues.reduce((nearest, candidate) => hueDistanceDegrees(candidate, sourceHue) < hueDistanceDegrees(nearest, sourceHue) ? candidate : nearest);
}
/**
 * Recolours `hex` into `targetScheme`'s own colour space rather than a
 * perturbation of `hex` itself. A genuinely coloured source — chroma at or
 * above MIN_REPAIRED_CHROMA, the same "recognisably tinted, not a grey"
 * floor repair.ts holds a repaired role to — is re-expressed at the hue of
 * whichever of `targetScheme`'s own six base ANSI colours reads as the same
 * hue family (see nearestHueFamilyHue); a near-neutral source keeps its own
 * (largely irrelevant) hue, since there is no family for a grey border or
 * label to belong to. Chroma is always the source's own, both cases: two
 * keys that started at different saturations — chips's own vivid battery-
 * error red next to its muted date-segment grey-blue — must stay
 * distinguishable by more than luminance alone once several keys land in the
 * same destination hue family, and a theme's own base colour is one fixed
 * chroma, not a range a source's whole spread of them could map onto without
 * collapsing most of it.
 *
 * Either way, only luminance moves — from wherever the source sat between
 * black (0) and white (1), to the same relative point between `groundHex`
 * and whichever of pure black or pure white sits farthest from it —
 * poleWithMoreHeadroom, the same "which extreme has more room" question
 * repair.ts asks when a role needs to move away from ground. A key that
 * started near-black lands near the new theme's own dark pole, and one
 * that started near-white lands near its light pole, whatever the new
 * theme's own appearance turns out to be.
 *
 * The far pole is the true extreme (luminance 0 or 1), not one of
 * Chameleon's own repaired roles such as body: two roles are each only
 * guaranteed to individually clear TEXT_MIN_RATIO against ground, never
 * against each other, so a foreign key retinted toward body can still land
 * within a hair of error or success by coincidence (Solarized Light's body
 * and error measure 0.154 and 0.158 relative luminance — near-identical).
 * The true extreme carries no such risk: nothing repair.ts ever produces
 * sits at literal black or white, so anything genuinely dark or light in
 * the original key stays the most extreme thing on the segment it renders
 * on, by construction.
 *
 * Luminance, not HSL lightness, is what this measures and targets — a fully
 * saturated yellow reads far lighter than its own HSL lightness number
 * suggests (yellow's green and red channels both carry heavy luminance
 * weight), so targeting HSL lightness let a yellow badge and a mid-grey
 * text colour land on the same measured luminance and vanish into each
 * other. matchValueForLuminance (repair.ts's own hue/chroma-preserving
 * search, reused rather than duplicated) is what makes targeting the real
 * luminance possible without giving up hue or chroma.
 *
 * This is what keeps CHM-37's distinctness guarantee even though CHM-53
 * changes whose hue is carried through: within one destination hue family
 * the map is still monotonic in both chroma and luminance, so two sources
 * land on the same colour only if they already agreed on family, chroma
 * *and* relative luminance — never merely a rough similarity in one alone.
 */
function retintByLuminance(hex, targetScheme, groundHex) {
    const originalHue = toHsl(hex).hue;
    const chroma = chromaOf(hex);
    const isGenuinelyColoured = chroma >= MIN_REPAIRED_CHROMA;
    const hue = isGenuinelyColoured ? nearestHueFamilyHue(originalHue, targetScheme) : originalHue;
    const groundLuminance = relativeLuminance(groundHex);
    const farPoleLuminance = poleWithMoreHeadroom(groundHex) ? 1 : 0;
    const darkPoleLuminance = Math.min(groundLuminance, farPoleLuminance);
    const lightPoleLuminance = Math.max(groundLuminance, farPoleLuminance);
    const originalLuminance = relativeLuminance(hex);
    const targetLuminance = darkPoleLuminance + originalLuminance * (lightPoleLuminance - darkPoleLuminance);
    const matchValue = matchValueForLuminance(hue, chroma, targetLuminance);
    return fromHueChromaMatch({ hue, chroma, matchValue });
}
/**
 * The colour a foreign palette key becomes when Chameleon retints a scheme.
 * A name that reliably announces its own intent is pinned to that role's
 * resolved colour outright; everything else is re-expressed in
 * `targetScheme`'s own colour space, at the same relative lightness the
 * source held in its own scheme — see retintByLuminance. This is CHM-37's
 * replacement for CHM-31's nearestRoleFor, which threw away the distinction
 * between keys and snapped every one onto one of six flat roles, and
 * CHM-53's replacement for CHM-37's own retintByLuminance, which carried a
 * key's hue and chroma through unchanged and so barely moved at all.
 */
export function recoloredHexFor(name, hex, resolvedRoleHexes, targetScheme) {
    const impliedRole = roleImpliedByName(name);
    if (impliedRole)
        return resolvedRoleHexes[impliedRole];
    return retintByLuminance(hex, targetScheme, resolvedRoleHexes.ground);
}
/**
 * Lightness (HSL percent, [0, 100]) above which a colour too near-neutral to
 * belong to any hue-based role reads as body text rather than muted — the
 * same split assignRolesByContrast draws between a scheme's own foreground
 * and its dim secondary slot (roles.ts), applied here to one standalone
 * colour with no scheme of its own to compare against.
 */
const NEUTRAL_BODY_LIGHTNESS_THRESHOLD = 50;
/**
 * The role `hex` most resembles by its own measured hue and lightness alone
 * — never `ground`, since every caller here is recolouring a segment's own
 * foreground, and a foreground landing on the same colour as the background
 * it renders over is exactly the failure repairSegmentForegrounds exists to
 * catch afterwards. Reuses the same red/green/cool hue bands roles.ts
 * classifies a scheme's own slots by (see hueCategoryOf there), so a hue this
 * calls "success" and a hue assignRolesByContrast calls "green" are always
 * the same hue. A colour with too little chroma to belong to any hue family
 * — below MIN_REPAIRED_CHROMA, the same "recognisably tinted, not a grey"
 * floor repair.ts holds every role to — falls back to a lightness split
 * between body and muted instead, same as a hue that lands in neither band
 * (the yellow/orange gap roles.ts's own hueCategoryOf calls "other").
 */
function nearestRoleByHue(hex) {
    const { hue, lightness } = toHsl(hex);
    if (chromaOf(hex) >= MIN_REPAIRED_CHROMA) {
        if (hue < RED_HUE_MAX_DEGREES || hue >= RED_HUE_WRAP_MIN_DEGREES)
            return "error";
        if (hue >= GREEN_HUE_MIN_DEGREES && hue < GREEN_HUE_MAX_DEGREES)
            return "success";
        if (hue >= GREEN_HUE_MAX_DEGREES && hue < RED_HUE_WRAP_MIN_DEGREES)
            return "accent";
    }
    return lightness >= NEUTRAL_BODY_LIGHTNESS_THRESHOLD ? "body" : "muted";
}
/**
 * The colour a lifted literal-hex palette key becomes when Chameleon retints
 * a scheme — CHM-90's replacement for recoloredHexFor when `hex` came from
 * CHM-74's literal-hex lift (see oh-my-posh.ts's
 * LITERAL_COLOR_PALETTE_KEY_PREFIX), never for a key a theme author actually
 * named.
 *
 * A named key like chips.omp.json's c-git-ahead carries a relationship to
 * every other key in that same prompt worth protecting, which is exactly
 * what recoloredHexFor's hue-family-preserving retint is for — see its own
 * doc comment, and CHM-37/CHM-53's reasoning for why. A literal key carries
 * none of that: it is one segment's own decorative hex, picked by whichever
 * theme the user's prompt happened to be written in, with no other key
 * depending on it staying in the same hue family. Preserving that hue family
 * regardless is CHM-90's own bug report — a prompt that stays recognisably
 * red, or teal, under every pack it is ever applied to, because a hue family
 * is exactly the thing a hue-preserving retint holds fixed. This snaps a
 * literal key fully onto the destination pack's own resolved role colour
 * instead, so a pack switch changes it exactly as much as it changes body or
 * accent — see nearestRoleByHue.
 */
export function recoloredLiteralHexFor(hex, resolvedRoleHexes) {
    return resolvedRoleHexes[nearestRoleByHue(hex)];
}
/** The hue each prompt colour aims at. Sampled from where these families actually sit across the bundled schemes, not from the RGB primaries. */
const PROMPT_COLOR_TARGET_HUES = {
    blue: 230,
    cyan: 180,
    green: 110,
    purple: 295,
    yellow: 50,
    red: 0,
};
/** Which resolved role stands in for each prompt colour when the scheme carries nothing near that hue. */
const PROMPT_COLOR_FALLBACK_ROLE = {
    blue: "accent",
    cyan: "accent",
    green: "success",
    purple: "accent",
    yellow: "success",
    red: "error",
};
/**
 * The order colours are handed out. Earlier entries get first pick, so the
 * three segments a prompt always shows — identity, separators, path — are
 * the ones guaranteed to look different from each other.
 */
const PROMPT_COLOR_ASSIGNMENT_ORDER = ["blue", "green", "cyan", "purple", "yellow", "red"];
/**
 * Anchors the first colour so a prompt's identity segment stays broadly cool
 * across themes rather than landing on whatever a given palette happens to
 * offer first. Everything after it is chosen for separation, not for hue.
 */
const PROMPT_ANCHOR_HUE = 220;
/**
 * Which of the theme's own resolved roles each prompt colour prefers, before
 * falling back to searching the scheme's slots. These are the three the
 * picker draws its per-theme dots from, so the prompt and the list a person
 * chose from agree about what the theme looks like. muted is deliberately
 * absent — a grey separator reads as unthemed however correct it is.
 */
const PROMPT_COLOR_FROM_ROLE = {
    blue: "accent",
    green: "success",
    yellow: "error",
};
export function promptPaletteFor(scheme, resolvedRoleHexes) {
    const claimed = [];
    const assigned = {};
    for (const name of PROMPT_COLOR_ASSIGNMENT_ORDER) {
        // Every colour but red refuses a red-hued slot outright. A prompt paints
        // hostnames and branch names with these, and red on either reads as
        // something being broken — so a theme with no real purple gives up its
        // purple rather than borrowing its red, which is how Nord's git segment
        // came out #bf616a.
        // Every slot a theme ships is a candidate, red family included. Reds are
        // simply far from most of the target hues below, so they win only where a
        // theme has nothing closer — which is exactly the case that used to leave
        // two prompt segments the same colour on cool-dominant palettes like Rosé
        // Pine and Terafox. A theme with a real purple still gets its purple.
        const usable = visiblePromptSlots(scheme, resolvedRoleHexes.ground).filter((hex) => !claimed.includes(hex));
        // Targeting a fixed hue per name was the mistake: blue and cyan sit close
        // enough that most palettes answer both with the same colour, and a
        // prompt whose identity and path are technically different reads as
        // unthemed anyway — Dracula's #8be9fd beside #a4ffff. Only the first
        // colour aims at a hue; every one after it is simply the candidate
        // furthest from everything already taken, so a palette's own spread
        // decides the colours rather than a table written against no theme in
        // particular.
        // The theme's own role colour first, where it is good enough to use.
        // These three are the colours the picker paints each theme's dots with,
        // so a prompt built on them reads as the same theme the list showed —
        // Monokai's #66d9ef identity, Dracula's #ff5555 state.
        //
        // The one role that gets skipped is one the theme itself clearly beats:
        // TangoTango's accent is #e0ffff, a near-white cyan chosen for contrast,
        // while the same scheme ships #34e2e2 five times as saturated in the same
        // family. Taking the role there would put the palest thing the theme owns
        // on the segment naming the user.
        const roleColour = PROMPT_COLOR_FROM_ROLE[name];
        const fromRole = roleColour === undefined ? undefined : resolvedRoleHexes[roleColour];
        const isRoleUsable = fromRole !== undefined &&
            !claimed.includes(fromRole) &&
            !hasFarMoreVividSibling(fromRole, scheme, resolvedRoleHexes.ground) &&
            claimed.every((taken) => isTellableApart(fromRole, taken));
        if (isRoleUsable) {
            assigned[name] = fromRole;
            claimed.push(fromRole);
            continue;
        }
        // The target hue first, but only among candidates that will not read as
        // a colour already taken. TangoTango's blue identity and cyan path sit
        // 30 degrees apart and look right; Dracula's #8be9fd beside #a4ffff does
        // not. So the bar is "tellable apart", and only when nothing clears it
        // does the target hue get abandoned for whatever sits furthest from
        // everything already claimed — a colour of its own beats a near-duplicate
        // of the one before it.
        const distinct = usable.filter((hex) => claimed.every((taken) => isTellableApart(hex, taken)));
        const picked = nearestToHue(distinct, resolvedRoleHexes.ground, PROMPT_COLOR_TARGET_HUES[name]) ??
            furthestFromClaimed(usable, claimed);
        // The role fallback is shared between names — blue and cyan both stand
        // in with accent — so it is only taken when nothing has claimed it yet.
        // Otherwise two segments end up literally the same colour, which is the
        // one outcome none of this is allowed to produce.
        const fallback = resolvedRoleHexes[PROMPT_COLOR_FALLBACK_ROLE[name]];
        const resolved = picked ?? (claimed.includes(fallback) ? undefined : fallback);
        assigned[name] = resolved ?? furthestFromClaimed(visiblePromptSlots(scheme, resolvedRoleHexes.ground), claimed) ?? fallback;
        if (assigned[name] !== undefined)
            claimed.push(assigned[name]);
    }
    return assigned;
}
/**
 * Two hues this close are the same colour to a person, so the choice between
 * them should be settled by something they can actually see. Without it a
 * slot 1.4 degrees nearer the target wins over one with two and a half times
 * the chroma — which is how TangoTango's prompt ended up wearing #729fcf
 * instead of the dodger blue sitting next to it in the same scheme.
 */
const SAME_HUE_TOLERANCE_DEGREES = 15;
/**
 * The scheme's own slot closest to `targetHue` that a person could actually
 * see against ground. Ties inside SAME_HUE_TOLERANCE_DEGREES go to the more
 * chromatic candidate, and then to the one that stands out further from
 * ground — so a family's vivid member beats its washed-out sibling, and
 * between two equally vivid ones the more visible wins.
 */
/**
 * How much colour a slot needs before a prompt will use it. Deliberately
 * below MIN_REPAIRED_CHROMA, which is a floor for *repairing* a colour into
 * something recognisably tinted — a different question from whether a colour
 * a theme author already chose is worth painting with. Nord is the case that
 * settles it: its own green and purple measure 0.196 and 0.149, so the
 * repair floor excluded a deliberately muted theme's entire palette and left
 * the prompt borrowing Nord's red for its git segment. This admits those two
 * while still rejecting the greys — Nord's own black and white measure 0.09
 * and 0.04.
 */
const PROMPT_MIN_CHROMA = 0.12;
/**
 * How far a prompt colour has to stand off the background. Higher than
 * ANSI_MIN_RATIO, which asks only whether a colour is visible at all: at 2.0
 * the muddy near-background slots stayed eligible, and night-owl-dark's
 * #384d5e and tokyo-night-dark's #474e6e were picked for a path that a person
 * then had to look for.
 */
const PROMPT_MIN_GROUND_RATIO = 3;
function visiblePromptSlots(scheme, groundHex) {
    return [...new Set(ANSI_SLOT_NAMES.map((slot) => scheme[slot]))]
        .filter((hex) => chromaOf(hex) >= PROMPT_MIN_CHROMA)
        .filter((hex) => contrastRatio(hex, groundHex) >= ANSI_MIN_RATIO);
}
function nearestToHue(visible, groundHex, targetHue) {
    if (visible.length === 0)
        return undefined;
    return visible.reduce((best, candidate) => {
        const candidateDistance = hueDistanceDegrees(toHsl(candidate).hue, targetHue);
        const bestDistance = hueDistanceDegrees(toHsl(best).hue, targetHue);
        if (Math.abs(candidateDistance - bestDistance) > SAME_HUE_TOLERANCE_DEGREES) {
            return candidateDistance < bestDistance ? candidate : best;
        }
        if (chromaOf(candidate) !== chromaOf(best))
            return chromaOf(candidate) > chromaOf(best) ? candidate : best;
        return contrastRatio(candidate, groundHex) > contrastRatio(best, groundHex) ? candidate : best;
    });
}
/**
 * Whether two prompt colours would actually read as different colours side by
 * side. Either a clear hue separation, or — for two colours of the same
 * family — enough of a lightness gap that one is obviously the paler.
 */
function isTellableApart(hex, other) {
    // A near-grey has no meaningful hue — the number HSL reports for one is
    // noise, and comparing against it says nothing about whether two colours
    // look different. TangoTango's #e0ffff measured 120 degrees from body
    // #eeeeec on that basis and was called distinct, which is how the identity
    // segment ended up all but invisible against the path beside it. When
    // either side is that close to grey, only lightness counts.
    const isEitherNearGrey = chromaOf(hex) < PROMPT_MIN_CHROMA || chromaOf(other) < PROMPT_MIN_CHROMA;
    if (!isEitherNearGrey && hueDistanceDegrees(toHsl(hex).hue, toHsl(other).hue) >= DISTINCT_HUE_DEGREES)
        return true;
    return contrastRatio(hex, other) >= DISTINCT_LIGHTNESS_RATIO;
}
/** Hue separation at which two prompt colours stop reading as the same one. */
const DISTINCT_HUE_DEGREES = 25;
/** How far apart two same-hue prompt colours must sit in lightness to still be told apart. */
const DISTINCT_LIGHTNESS_RATIO = 1.6;
/**
 * The candidate that comes closest to reading as its own colour against
 * everything already taken — the last resort when nothing clears
 * isTellableApart outright.
 *
 * Scored on the same two axes that function tests, rather than on hue alone:
 * ranking by hue distance by itself once returned colours that were no more
 * distinguishable than the ones they beat, because a large hue gap between
 * two near-greys is worth nothing. Each axis is measured as a fraction of its
 * own bar, so a candidate half way to clearing on lightness ranks above one a
 * quarter of the way there on hue.
 */
function furthestFromClaimed(candidates, claimed) {
    if (candidates.length === 0)
        return undefined;
    if (claimed.length === 0)
        return candidates[0];
    const distinctness = (hex, taken) => Math.max(hueDistanceDegrees(toHsl(hex).hue, toHsl(taken).hue) / DISTINCT_HUE_DEGREES, (contrastRatio(hex, taken) - 1) / (DISTINCT_LIGHTNESS_RATIO - 1));
    const worstCase = (hex) => Math.min(...claimed.map((taken) => distinctness(hex, taken)));
    return candidates.reduce((best, candidate) => (worstCase(candidate) > worstCase(best) ? candidate : best));
}
/**
 * How much more saturated a sibling has to be before it displaces a role
 * colour. Well clear of the difference between two ordinary members of a
 * family, so this only fires on a role that was picked for contrast at the
 * cost of nearly all its colour.
 */
const VIVID_SIBLING_CHROMA_FACTOR = 2;
/** Whether the scheme carries a colour of the same family as `hex` that is far more saturated — see the note in promptPaletteFor. */
function hasFarMoreVividSibling(hex, scheme, groundHex) {
    return visiblePromptSlots(scheme, groundHex).some((candidate) => hueDistanceDegrees(toHsl(candidate).hue, toHsl(hex).hue) < DISTINCT_HUE_DEGREES &&
        chromaOf(candidate) >= chromaOf(hex) * VIVID_SIBLING_CHROMA_FACTOR);
}
//# sourceMappingURL=role-mapping.js.map