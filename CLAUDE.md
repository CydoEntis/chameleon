# chameleon

`ch` retints an entire terminal — Windows Terminal colours, the Oh My Posh
prompt, and Herdr's UI — from one source palette, with nothing to restart.
It adapts colour schemes that already exist; it is **not** a theme designer,
and it does not generate palettes from a base colour.

## Read this first

**[`.claude/references/code-standards.md`](.claude/references/code-standards.md)** — how code here
is shaped: naming, function shape, where logic lives, what gets a constant, what a test is for.
This file is the rulebook; that one is the depth behind it. Read it before writing code, and work
its checklist before saying you are done.

## Layout

```
src/
  cli.ts          argument parsing and terminal output only — no logic
  index.ts        the library surface
  adapters/       one file per target; all file and process I/O lives here
  palette/        pure: parse, measure, assign roles, repair. No I/O, ever.
  constants.ts    contrast floors, role names, target names
themes/           bundled theme packs, shipped in the published package
test/             mirrors src/; *.test.ts
```

## Commands

```
npm test          vitest run — the gate; must pass before anything ships
npm run typecheck tsc --noEmit
npm run build     tsc to dist/
npx jscpd src     find duplicates that were given different names
```

## Three words that are not interchangeable

- **scheme** — raw upstream input: 16 ANSI slots plus background, foreground, cursor, selection
- **palette** — Chameleon's resolved roles after measurement and repair
- **pack** — a shippable theme: a palette plus per-target payloads and a manifest

Never use one where another is meant.

## How to write code here

**Comments.** Carry *why*, not *what*. The valuable comment here explains a colour decision or a
config-format quirk that would otherwise look like a mistake and get "cleaned up" by the next
reader. A comment restating the line below it gets deleted in review.

**Tests.** A test earns its place by covering something that can silently produce wrong output:
contrast maths, role assignment, palette repair, and every config edit. Colour tests use real
schemes' real hex values, never invented ones. Config-editing tests use fixtures containing
comments, odd key order and unrelated settings, and assert those survive byte for byte.

**Structure.** New target support is a new file in `adapters/` implementing `detect()` / `read()` /
`apply()` / `reload()` and nothing else — if adding an adapter requires touching the core, the
interface is wrong. Colour logic lives in `palette/` and stays pure, so it can be tested against
fixtures and reused by the build-time pass that repairs the bundled themes.

**Dependencies.** The bar is high; this is a CLI people install globally, and every dependency runs
on the machine of everyone who typed `ch`. Node's standard library first. Nothing for colour maths
or JSON/TOML editing without a concrete argument in the PR that hand-rolling it is worse.

## Rules that are load-bearing

- **Never rewrite a config file wholesale.** Every write is scoped between `ch:begin` / `ch:end`
  markers, and everything outside them is preserved byte for byte. These files hold hand-written
  comments and unrelated settings that took people hours. A round-trip through a parser silently
  discards comments and reorders keys. Eat one user's config and the tool is dead.

- **Back up before every write, and make `ch undo` work.** A user must always be one command away
  from the state they were in. The tool's entire risk sits in editing files it did not create.

- **Never ship a colour that fails its contrast floor.** Body and accent clear 4.5:1 against their
  own ground; muted clears 3.0:1 *and* sits below body. Mechanical mapping produces broken output
  in roughly a fifth of real themes — Solarized Dark's muted scores 2.11, Solarized Light's
  inverts and outranks its body text. Repair runs before anything reaches a prompt.

- **Never trust an ANSI slot's name.** Rosé Pine Dawn's `green` slot holds a blue and its `cyan`
  holds a pink. Roles are chosen by measured contrast against that theme's own background; the slot
  name is a tiebreak at most.

- **Nothing in `src/palette/` touches the filesystem or spawns a process.** Not "should not" —
  does not. It is what makes the risky half of this product testable.

- **Terminal output must read without a Nerd Font installed.** No emoji, no box drawing. Chameleon
  of all tools cannot assume the user's font already works — a broken font is the problem it exists
  to detect.

- **TypeScript, never plain JavaScript.** Including throwaway scripts.
