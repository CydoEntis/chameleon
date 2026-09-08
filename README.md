# Chameleon

One command retints your whole terminal — Windows Terminal's colours, your
Oh My Posh prompt, Herdr's UI, and Claude Code's own theme — from a single
palette. Everything reloads live except Claude Code, which needs a restart and
says so.

```sh
npm install -g CydoEntis/chameleon
chm themes
```

That is the whole install. npm clones the repository and builds it on the way
in, so there is nothing to compile by hand. `chm themes` then opens a picker;
arrow keys preview each theme live, enter applies it everywhere at once, esc
puts back what you had.

Chameleon is installed from this repository, not from the npm registry — the
package is marked private, so it is not published there and will not be. To
update, run the same command again. To remove it, `npm uninstall -g
@cydoentis/chameleon`; run `chm original` first if you want your own colours
back.

### If PowerShell refuses to run npm

```
npm : File C:\Program Files\nodejs\npm.ps1 cannot be loaded because running
scripts is disabled on this system.
```

That is Windows blocking npm itself rather than anything to do with
Chameleon — every global npm install fails the same way until it is dealt
with. Either run the batch shim, which the policy does not cover:

```powershell
npm.cmd install -g CydoEntis/chameleon
```

or lift the restriction once, for your own account only:

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

`CurrentUser` needs no administrator rights, and `RemoteSigned` still refuses
unsigned scripts downloaded from the internet — it only allows local ones like
npm's own shim. That fixes npm for good, not just for this package.

## Requirements

- **Node.js 20 or newer.** Nothing else.
- **At least one of the four targets installed.** Chameleon themes whatever it
  finds and skips the rest — it never fails because you do not use one of
  them. `chm doctor` prints what it found.

| Target | Windows | macOS | Linux |
|---|---|---|---|
| Windows Terminal | yes | — | — |
| Oh My Posh | yes | yes | yes |
| Herdr | yes | yes | yes |
| Claude Code | yes | yes | yes |

Windows Terminal only exists on Windows, and `chm doctor` says "not available
on this platform" there rather than "not found" — a Linux user is not missing
something they were supposed to install. Shell integration covers PowerShell,
bash and zsh.

## Commands

```sh
chm themes               # interactive picker: arrows preview, enter applies, esc restores
chm themes --list        # plain list with swatches (also the automatic output when piped)
chm pick                 # alias for `chm themes`

chm catppuccin-dark      # apply by slug
chm "Catppuccin Mocha"   # ...or by display name, case- and separator-insensitive
chm catppuccin mocha     # ...or as bare words

chm dark / chm light     # flip mode within the same family
chm next / chm prev      # cycle through every theme — worth binding to keys
chm current              # print the active theme (--short for just the name)

chm undo                 # put back the theme applied before this one
chm original             # put everything back exactly as it was before Chameleon ever ran
chm doctor               # what is installed, and what needs restarting

chm statusline on        # let Chameleon manage Claude Code's status line
chm edit ...             # edit the Oh My Posh prompt layout
chm reseed <path>        # re-seed the Oh My Posh config Chameleon owns
chm clean                # remove dead Windows Terminal scheme forks from older versions
```

## What it does to your files, and how to undo it

Chameleon's entire risk is that it edits config files it did not write. Four
rules keep that safe, and they are worth knowing before you run it:

- **Every write is scoped between `ch:begin` and `ch:end` markers.**
  Everything outside them is preserved byte for byte — your comments, your key
  order, your unrelated settings. Chameleon never round-trips your config
  through a parser and writes it back out, because that silently drops
  comments and reorders keys.
- **Every file is backed up before it is written**, and `chm undo` is always
  one command away.
- **`chm original` restores everything** to exactly the state it was in before
  Chameleon's first apply — captured once, on that first run.
- **Every write is atomic.** The new file is staged alongside the old one and
  published with a single rename, so an application watching the file sees the
  whole old version or the whole new one, never a half-written seam.

## Why the colours are not just copied across

Terminal schemes are not designed for the things Chameleon paints them onto. A
prompt segment, a sidebar row and a selection highlight all need text to stay
readable on a background the original scheme's author never considered.

So Chameleon measures rather than maps. Every colour is assigned a role by its
measured contrast against that theme's own background, never by the name of
the ANSI slot it came from — Rosé Pine Dawn's `green` slot holds a blue, and
its `cyan` holds a pink. Anything that fails its contrast floor is repaired
before it ships: body and accent clear 4.5:1 against their own ground, muted
clears 3.0:1 and stays below body.

That matters more than it sounds. **433 of the 606 upstream schemes have at
least one role that fails** — seven in ten. Solarized Dark's muted scores
2.11; Solarized Light's inverts and outranks its own body text.

## Themes

63 bundled packs, light and dark. Most are adapted from
[mbadolato/iTerm2-Color-Schemes](https://github.com/mbadolato/iTerm2-Color-Schemes)
(MIT); the rest come from each theme's own upstream. Copyright in every
individual theme belongs to its author — see
[themes/ATTRIBUTION.md](themes/ATTRIBUTION.md) for the full list, each pinned
to a commit.

Two are worth calling out if you redistribute this yourself: **TangoTango** is
GPL-3.0-or-later (four colour values are taken from it), and **Turtles**
declares no licence upstream at all. Both are recorded as such in
`ATTRIBUTION.md` rather than assumed to be permissive.

`chm themes` opens an interactive picker in a TTY — arrow keys move, live
preview repaints the terminal as you go, enter applies, esc restores whatever
was active before you started picking. Themes are grouped by light and dark,
the way an editor's theme picker groups them. Piped, or with `--list`, it
prints the plain list instead: every pack `chm` can apply — the bundled ones
plus anything of your own — by the name a person reads, with a marker only on
the packs that aren't bundled:

```
Catppuccin Mocha (mine)  (user)
Catppuccin Latte
Dracula
```

### Naming a theme

`chm <theme>` accepts either the slug (`chm catppuccin-dark`) or the display
name — quoted (`chm "Catppuccin Mocha"`) or given as separate words
(`chm catppuccin mocha`) — matched case- and separator-insensitively, so
`Catppuccin Mocha`, `catppuccin-mocha` and `catppuccin_mocha` all reach the
same pack. A name that is a prefix of more than one theme (`chm catppuccin`,
with both a Mocha and a Latte installed) lists the candidates rather than
guessing which one you meant; a name that matches nothing at all suggests the
closest match instead.

### Drop-in packs

A pack is a directory with a `pack.json` manifest. Drop one in and it is
selectable immediately — no install, no registry, no restart:

| | |
|---|---|
| Windows | `%LOCALAPPDATA%\chameleon	hemes\<your-pack-name>\` |
| macOS, Linux | `$XDG_DATA_HOME/chameleon/themes/<your-pack-name>/`, falling back to `~/.local/share/chameleon/themes/<your-pack-name>/` |

The manifest's `slug` is what the pack loads as, and it is the only thing
that decides whether a pack overrides one already installed. **A pack whose
`slug` matches a bundled pack's replaces it; any other slug just adds to the
list.** `slug` is the one field worth getting right: it is never derived from
`name`, so naming your pack the same as a bundled theme does nothing on its
own — you have to declare the bundled pack's own slug. `chm themes` no longer
prints it (slugs stay typeable, just not shown — see "Naming a theme" above),
but every bundled pack's slug is the file name it ships as under `themes/` —
`catppuccin-dark` for the pack named "Catppuccin Mocha", say. If you leave
`slug` out entirely, Chameleon derives one from `family` and the scheme's own
light/dark appearance, the same way a bundled pack's slug is built — and says
so with a warning on `chm themes`, since a silently derived slug is exactly
what makes an override fail without any sign why.

The manifest also names the one colour scheme the pack adapts — the same 16
ANSI colours plus background, foreground, cursor and selection every Windows
Terminal scheme carries — and an optional `family` for grouping it with a
light or dark sibling of its own. Chameleon computes everything else (which
colour plays which role, contrast repair, every target's payload) the same
way it does for a bundled pack, so a dropped-in theme is held to the same
contrast floors — see `CLAUDE.md`, "Never ship a colour that fails its
contrast floor".

Worked example: overriding the bundled `catppuccin-dark` pack with a
personal recolour, at `…/chameleon/themes/my-catppuccin/pack.json`:

```json
{
  "slug": "catppuccin-dark",
  "name": "Catppuccin Mocha (mine)",
  "family": "Catppuccin",
  "scheme": {
    "name": "Catppuccin Mocha (mine)",
    "black": "#45475a",
    "red": "#f38ba8",
    "green": "#a6e3a1",
    "yellow": "#f9e2af",
    "blue": "#89b4fa",
    "purple": "#f5c2e7",
    "cyan": "#94e2d5",
    "white": "#bac2de",
    "brightBlack": "#585b70",
    "brightRed": "#f38ba8",
    "brightGreen": "#a6e3a1",
    "brightYellow": "#f9e2af",
    "brightBlue": "#89b4fa",
    "brightPurple": "#f5c2e7",
    "brightCyan": "#94e2d5",
    "brightWhite": "#a6adc8",
    "background": "#1e1e2e",
    "foreground": "#cdd6f4",
    "cursorColor": "#f5e0dc",
    "selectionBackground": "#585b70"
  }
}
```

Because the directory name (`my-catppuccin`) plays no part in this — only
the declared `slug` does — `chm themes` now shows "Catppuccin Mocha (mine)"
once, marked `(user)`, with this pack's colours instead of the bundled one's.

A manifest that is missing `scheme`, has a malformed colour, or is not valid
JSON is reported by its directory name on `chm themes` and skipped — every
other pack, bundled or user, still loads.

## Contributing

`npm test` is the gate — it must pass before anything ships. `npm run
typecheck` covers `src/`, and `npx tsc -p tsconfig.tools.json --noEmit` covers
the build tooling. `themes/` is generated and committed, so run `npm run
generate:themes` after touching anything under `src/palette/` and commit the
result; CI fails if the two disagree.

[`CLAUDE.md`](CLAUDE.md) describes how the project is put together and which
rules are load-bearing.

## License

MIT — see [LICENSE](LICENSE). Bundled themes carry their own copyright; see
[themes/ATTRIBUTION.md](themes/ATTRIBUTION.md).
