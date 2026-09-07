# Code standards

How code in this repo is *shaped*. `CLAUDE.md` carries the short imperative form of every rule here
and is the rulebook; this file is the depth behind it.

Adapted from the house standard for Chameleon, which is a Node CLI: no browser, no server, no
database. The rules about naming, function shape, values, abstraction and tests are unchanged. The
rules about where logic lives have been rewritten for this architecture.

Everything here serves one goal: **the next reader — a teammate or an agent, six weeks from now —
understands a function without holding the rest of the file in their head.**

Rules stated here are house rules. Where one is mechanically enforced this file says so; where it is
not, it is still binding, and "the typechecker didn't complain" is not a defence.

---

## Naming

### A name says exactly what the thing is or does

If the name needs a comment to explain it, the name is wrong. Fix the name, delete the comment.

- **No single-letter names.** Not `e`, not `s`, not `i`, not `c`. This includes lambda parameters
  and caught errors — `catch (error)`, `schemes.map(scheme => …)`, `roles.filter(role => …)`.
  A single letter tells the reader nothing and costs nothing to expand.
- **No abbreviations the domain does not already use** — except where the domain has settled on the
  short form (`hex`, `rgb`, `hsl`, `ANSI`, `WCAG`, `omp`, `wt`). Do not coin a new abbreviation.
- **No `data`, `info`, `item`, `obj`, `result`, `temp`, `handleThing`, `doThing`.** Say what it
  holds: `schemeRows`, `repairedPalette`, `failingRoleCount`.
- **A name states its unit when the unit is not obvious** — `contrastRatio`, `backoffMs`,
  `lightnessStep`. A bare `contrast` could be a ratio, a percentage, or a boolean.

### One concept, one word — everywhere

The same thing carries the same name in the parser, the adapter, the theme pack and the test. If it
is a `scheme` where it is parsed it is not a `theme` in the adapter and a `palette` in a manifest.
Two names for one concept means a reader has to prove they are the same thing every time they cross
a boundary.

These three are genuinely different here, and the distinction is load-bearing:

| Word | Means |
|---|---|
| **scheme** | The raw upstream input — 16 ANSI slots plus background, foreground, cursor, selection |
| **palette** | Chameleon's resolved roles after measurement and repair — ground, body, accent, muted, success, error |
| **pack** | A shippable theme: a palette plus per-target payloads and a manifest |

Never use one where another is meant.

### A boolean reads as an assertion

Prefix with `is` / `has` / `can` / `should`. Never a negation (`isNotInstalled`), never a bare noun
(`status`, `flag`) for a boolean.

**Extract the predicate the moment the condition stops being self-evident.**

```ts
// The reader has to work out what 3 means, and what the comparison is protecting.
if (ratio(role, ground) < 3 && ratio(body, ground) > ratio(role, ground)) return null

// The rule names itself.
const isMutedTooFaint = contrastRatio(muted, ground) < MUTED_MIN_RATIO
const doesMutedOutrankBody = contrastRatio(muted, ground) > contrastRatio(body, ground)
if (isMutedTooFaint || doesMutedOutrankBody) return repairMuted(palette)
```

A condition with two or more operators, or any comparison against a constant whose meaning is not
obvious from the value, gets a name.

### The rest

- **Functions read as verbs** — `parseScheme`, `assignRoles`, `repairPalette`, `applyTheme`,
  `detectTarget`. Not `fetch`, `handle`, `process`, `doThing`.
- **Adapter methods are the four in the interface** — `detect`, `read`, `apply`, `reload` — and an
  adapter exposes nothing else.
- **Every `.ts` file is kebab-case** — `windows-terminal.ts`, `contrast-ratio.ts`, `theme-pack.ts`.
- **No version suffixes in filenames** — `contrast_v2.ts`, `palette-new.ts` are never correct. Git
  does versioning.
- **Command names are single lowercase words** — `ch doctor`, `ch browse`, `ch edit`.
- **User-facing copy is sentence case** — "Theme applied", not "Theme Applied". It is terminal
  output, so it is also plain: no emoji, no box drawing, nothing that needs a Nerd Font to read.
  Chameleon of all tools must not assume the user's font already works.

---

## Functions

### One function, one job

A function does one thing at one level of abstraction. **If describing it honestly needs the word
"and", it is two functions.**

Symptoms of a function doing several jobs: it parses *and* repairs *and* writes; it detects *and*
installs *and* reloads; its name contains `And`, `Handle`, or `Process`; the tests for it need three
different setups.

### Keep functions thin — extract the inner logic

When a function grows fat, the fix is to lift the inner work into named helpers, not to add comments
or blank-line paragraphs. The parent then reads as a list of steps a person can follow, and each
step is independently readable and testable.

```ts
// The parent says WHAT happens. Each helper says HOW.
export function toPalette(scheme: Scheme): Palette {
  const appearance = appearanceOf(scheme)
  const assigned = assignRolesByContrast(scheme, appearance)
  const repaired = repairFailingRoles(assigned, scheme.background)
  return freezePalette(repaired)
}
```

**This is not a line-count rule.** A long, obvious, linear function is fine — a lookup table mapping
twenty ANSI slots is one function and should stay one. The rule bites when the length comes from
*nesting or mixed concerns*, not from length itself.

### Guard the edges first, then write the happy path flat

Handle every edge case with an early return at the top. What survives to the bottom is the one case
the function is actually about, at one indent level.

```ts
// Every case is a branch and the real work is four levels deep.
async function applyToTarget(target: Target, pack: Pack) {
  if (await target.detect()) {
    if (pack.payloads[target.name]) {
      if (await canWrite(target.configPath)) {
        return await target.apply(pack)
      } else {
        return { skipped: 'not writable' }
      }
    } else {
      return { skipped: 'no payload' }
    }
  }
  return { skipped: 'not installed' }
}

// The edges are dealt with and gone. The subject of the function is the last line.
async function applyToTarget(target: Target, pack: Pack) {
  if (!(await target.detect())) return skipped('not installed')
  if (!pack.payloads[target.name]) return skipped('no payload')
  if (!(await canWrite(target.configPath))) return skipped('not writable')

  return await target.apply(pack)
}
```

**Three levels of nesting is the ceiling.** Past that, extract a helper or invert the condition. This
applies to `if`, `for`, `try` and ternaries alike — **a nested ternary is never correct here**; use
an early return or a lookup object.

The same shape governs every command: validate arguments → check the target exists → back up → write
→ reload, each an early return on failure, never a nested chain.

### Compose small pieces; never duplicate a big one

Build functions that combine, rather than one that grows a `mode` parameter for every caller. When a
function sprouts a boolean parameter that switches out half its body, that is two functions sharing
a name.

---

## Values

### No magic strings, no magic numbers

A literal that carries meaning gets a named constant **the first time it is written, not the
second.** This covers contrast floors, marker text, config paths, reload commands, role names, and
every string compared against.

```ts
// What is 4.5? What is 3? What is that string doing?
if (ratio(body, ground) < 4.5) repair(body)
if (ratio(muted, ground) < 3) repair(muted)
const start = lines.findIndex(line => line.includes('ch:begin'))

// Each value now answers for itself, and changing it is a one-line edit.
const BODY_MIN_RATIO = 4.5
const MUTED_MIN_RATIO = 3
const MARKER_BEGIN = 'ch:begin'
```

**Not magic, and needing no constant:** `0`, `1`, `-1` used as arithmetic or index values; an array's
own `length`; the one line that defines the concept.

**Where a constant lives:**

| Scope | Home |
|---|---|
| Contrast floors, role names, target names | `src/constants.ts` |
| One adapter's config path, markers, reload command | Beside that adapter, in its own file |
| Anything a theme declares about itself | The pack manifest, never the code |

**A repeated value is a constant, not a coincidence.** The same literal in two places is the same bug
waiting in one of them. Name it once and import it in both.

**A contrast threshold never appears as a literal in a comparison.** It is the single most
consequential number in this codebase; it gets a name and one definition.

---

## Abstraction

### Two real uses extract. One imagined use does not.

These are the same rule from both sides, and they never conflict — one counts uses that exist, the
other refuses to count uses that do not.

- **Two call sites today → extract now, and convert both.** No threshold, no judgement call.
- **One call site and a hunch → write it inline.** "Every adapter will probably need this" is not a
  use. Build the concrete thing; extract it the day the second caller arrives.

**Fix the first call site too.** Extracting the helper and leaving the original copy in place is the
same duplication with an extra file.

`npx jscpd src` finds the copies that were given different names.

### An abstraction must remove complexity, not relocate it

Before adding a layer, wrapper, helper, generic parameter or config option, answer: does a reader who
has never seen this code understand the call site **faster** now? If they now have to open two files
instead of one, the abstraction is a cost with no benefit.

- **No new layer, wrapper or helper unless it removes more code than it adds.**
- **No config option, generic parameter or flag with one caller.**
- No wrapper whose body is a single pass-through call.

The adapter interface is the one abstraction this project commits to up front, because a fourth
terminal is a known future requirement and the interface is what keeps it from touching the core.
Everything else earns its place by having two callers.

### Prefer the boring version

- If two implementations are equally correct, ship the one a new reader understands without
  scrolling.
- A long, obvious function beats three short ones that must be read together.
- **No pattern, library, cache or abstraction without a concrete problem it solves today**, named in
  the pull request.

### Dependencies

The bar is high. This is a CLI people install globally: every dependency is install weight and
supply-chain surface, and a compromised one runs on the machine of everyone who typed `ch`.

Node's standard library first. Nothing for colour maths, JSON editing or TOML editing without a
concrete argument in the pull request that hand-rolling it is worse. A dependency that exists to
save twenty lines is not worth it.

---

## Where logic lives

### The path

```
ch <command>  →  src/cli.ts            argument parsing and terminal output only
              →  src/index.ts          the library surface
              →  src/palette/          pure: parse, measure, assign, repair
              →  src/adapters/<t>.ts   all file and process I/O, one per target
              →  the user's config files
```

Follow it in both directions.

### The pure half and the impure half

This is the most important structural rule in the repo, and it is what makes the risky part
testable.

| This | Lives in |
|---|---|
| Contrast maths, role assignment, palette repair, scheme parsing | `src/palette/` — pure functions, no I/O |
| Reading, editing, backing up and reloading a target's config | `src/adapters/<target>.ts` |
| Detecting what is installed, shelling out to a package manager | `src/adapters/<target>.ts` |
| Argument parsing, prompting, printing | `src/cli.ts` |
| Derivation with no I/O | A named helper beside its consumer |

**`src/palette/` performs no file I/O and spawns no process.** Not "should not" — does not. An
adapter may import from `palette/`; `palette/` never imports an adapter. If a colour function needs
to read a file to do its job, the reading belongs to the caller and the colour function takes the
contents.

A repair function that reads a config file inline is holding logic that cannot be tested without a
filesystem, and cannot be reused by the build-time pass that repairs the bundled themes.

### File and process access has exactly one home per target

**No `readFile`, no `writeFile`, no `spawn` outside `src/adapters/`.** Every write goes through the
adapter that owns that config, so there is one place backup happens, one place markers are honoured,
and one place to look when a user's config comes back wrong.

The one exception is the vendored scheme library, which is read at startup by the loader in
`src/palette/` — and is read-only, shipped with the package, and never user-owned.

### A file has one responsibility

A file holds one adapter, or one cohesive group of small pieces that are always read together. When
a file accumulates an adapter *and* its colour maths *and* unrelated utilities, split it along those
seams.

Signals: the imports at the top come from four unrelated areas; you scroll to find anything.

---

## Data

### Derive; do not store

Do not keep a value when it can be computed from what you already have. A `Palette` carries the
resolved roles; it does not also carry a copy of the scheme's raw slots "in case". Two copies of one
fact go out of sync, and reconciling them is code that should not exist.

The exception is measurement: luminance and contrast ratios are computed once at parse time and
carried, because they are expensive, pure, and can never disagree with their input.

### Data is immutable

Do not mutate objects, arrays or shared state in place. Build a new value: spread, `map`, `filter`,
and `[...schemes].sort(…)` rather than `schemes.sort(…)` — `sort` and `reverse` mutate.

**A parsed `Palette` is frozen.** Repair returns a new palette; it never edits the one it was given.
A repaired palette and its original are both valid values, and a test that compares them proves the
repair did what it claimed.

Do not reassign a function parameter — it makes the argument at the call site a lie.

### Validate at every boundary

Anything crossing into the app from outside is unvalidated until a schema says otherwise:

- A scheme file from the vendored library
- A theme pack manifest
- A user's existing `settings.json`, `config.toml` or `.omp.json`, before it is edited
- A pointer file or a backup read back from disk
- Command-line arguments

Parse with a Zod schema and **infer the type from the schema, never hand-write one beside it.**

A config the user hand-edited into something malformed must produce a message naming the file and
the problem. Never a crash, and never a silent overwrite — an unreadable config is exactly the case
where writing anyway destroys work.

---

## Tests

### Test behavior, not implementation

A test states what the code does for its caller. It does not assert on internal structure, call
order, or private helpers — those change when the implementation is improved, and **a test that
fails on an improvement is a test that punishes refactoring.**

Assert on: what a function returns for a given input, what ended up in the config file, which error
came back.

### Colour tests use real schemes' real values

Never invented hex. The defects this project exists to fix live in actual themes' quirks — Rosé Pine
Dawn's `green` slot holding a blue, Night Owlish Light's purple matching its foreground byte for
byte, Solarized Light's muted outranking its body text. A test built on made-up colours proves
nothing about the themes that ship.

The known failures are fixtures, and they stay fixtures: Solarized Dark muted at 2.11, Ayu Mirage at
2.78, Kanagawa Lotus at 2.93, Gruvbox's accent at 3.48 and 3.73.

### Config-editing tests use hostile fixtures

A fixture for a config-editing test contains comments, unusual key order, trailing commas where the
format allows them, and settings unrelated to anything Chameleon touches — and the test asserts all
of it survives byte for byte. The entire risk of this tool is in editing files it did not write, so
a fixture that is a clean minimal config tests nothing worth testing.

### Write the failing test first

Watch it fail for the right reason, then make it pass. Tests live beside their source: `foo.ts` →
`foo.test.ts`.

**Never report success on a red loop.** Never disable, skip, or `.only` a test to reach green. If a
test is wrong, say so and explain why before changing it — a test you edited to pass is a test you
deleted.

---

## The checklist

Before you say you are done:

- [ ] `npm run typecheck` — green
- [ ] `npm test` — green
- [ ] I reused what existed instead of building a second one (`npx jscpd src`)
- [ ] No single-letter names, no magic numbers, no nesting past three levels
- [ ] Every external input is parsed by a Zod schema
- [ ] Nothing in `src/palette/` touches the filesystem or spawns a process
- [ ] Every config write is marker-scoped, backed up first, and reversible
- [ ] No colour ships that fails its contrast floor
- [ ] No empty catch, no bare `throw new Error`, no `console.*` outside `cli.ts`
- [ ] No `any`, no `as` to silence an error, no `@ts-ignore`
- [ ] Terminal output reads without a Nerd Font installed
- [ ] I touched no file the task did not require
- [ ] The commit subject is `type(scope): what changed`, with no ticket id
- [ ] I said, at the top of my summary, anything I had to assume
