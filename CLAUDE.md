# chameleon

`ch` retints an entire terminal — Windows Terminal colours, the Oh My Posh
prompt, and Herdr's UI — from one source palette, with nothing to restart.
It adapts colour schemes that already exist; it is **not** a theme designer,
and it does not generate palettes from a base colour.

## Layout

```
src/
  cli.ts          argument parsing and the command table; a thin shell only
  index.ts        the library surface — everything testable lives behind here
  adapters/       one file per target, all implementing the same interface
  palette/        scheme parsing, role assignment, contrast repair
themes/           bundled theme packs, shipped in the published package
test/             mirrors src/; *.test.ts
```

## Commands

```
npm test          vitest run — the gate; must pass before anything ships
npm run typecheck tsc --noEmit
npm run build     tsc to dist/
```

## How to write code here

**Comments.** Carry *why*, not *what* — the code already says what. The
valuable comment on this project explains a colour decision or a config-format
quirk that would otherwise look like a mistake and get "cleaned up" by the next
reader. A comment restating the line below it gets deleted in review.

**Tests.** A test earns its place by covering something that can silently
produce wrong output: contrast maths, role assignment, palette repair, and
every config edit. Those are the parts where a bug is invisible until it is on
a user's screen. Any change to the palette pipeline comes with a test using a
real scheme's actual hex values — never invented colours, because the bugs
this project has are in real themes' quirks, not in hypothetical ones.

**Structure.** New target support is a new file in `adapters/`, implementing
`detect()` / `read()` / `apply()` / `reload()` and nothing else — if a change
requires touching the core to add an adapter, the interface is wrong. Colour
logic belongs in `palette/` and stays pure: no file I/O, so it can be tested
against fixtures.

**Dependencies.** The bar is high; this is a CLI people install globally, and
every dependency is install weight and supply-chain surface. Node's standard
library first. Nothing at all for colour maths or TOML/JSON editing without a
concrete argument that hand-rolling it is worse.

## Rules that are load-bearing

- **Never rewrite a config file wholesale.** Every write is scoped between
  `ch:begin` / `ch:end` markers, and everything outside them is preserved
  byte for byte. These files hold hand-written comments and unrelated settings
  that took people hours. A round-trip through a parser silently discards
  comments and reorders keys. Eat one user's config and the tool is dead.

- **Back up before every write, and make `ch undo` work.** A user must always
  be one command away from the state they were in. This is not a nicety: the
  tool's entire risk sits in editing files it did not create.

- **Never ship a colour that fails its contrast floor.** Body and accent clear
  4.5:1 against their own ground; muted clears 3.0:1 *and* sits below body.
  Mechanical mapping produces broken output in roughly a fifth of real themes
  — Solarized Dark's muted scores 2.11, Solarized Light's inverts and outranks
  its body text. Repair runs before anything reaches a prompt.

- **Never trust an ANSI slot's name.** Rosé Pine Dawn's `green` slot holds a
  blue and its `cyan` holds a pink. Roles are chosen by measured contrast
  against that theme's own background; the slot name is a tiebreak at most.

- **TypeScript, never plain JavaScript.** Including throwaway scripts.
