# Chameleon

One command retints your whole terminal — Windows Terminal colours, your
Oh My Posh prompt, Herdr's UI, and Claude Code's own theme — from a single
palette. Nothing restarts, except Claude Code itself.

```sh
npm i -g @cydoentis/chameleon

chm themes               # browse and pick interactively — arrow keys move, live preview repaints, enter applies, esc restores what was there
chm themes --list        # print the plain list instead, with swatches — same output automatically when piped or non-interactive
chm pick                 # alias for `chm themes`
chm catppuccin-dark      # apply by slug
chm "Catppuccin Mocha"   # apply by display name — matched case- and separator-insensitively
chm catppuccin mocha     # ...or the same name as bare words, joined
chm dark / chm light     # flip mode, same family
chm next / chm prev      # cycle either way — bind them to keys
chm current              # print the active theme's slug ("--short" for just its name)
chm undo                 # put it back
chm doctor               # what is installed
chm edit ...             # edit the Oh My Posh prompt layout
chm statusline           # print one themed line — this is what Claude Code's own statusLine runs
```

## Why

Changing how a terminal looks today means editing several unrelated config
files in several formats, and knowing which ones need a restart. Windows
Terminal, Oh My Posh and Herdr all reload live; Claude Code does not watch its
own settings.json, so `chm doctor` and every apply say plainly when it needs
one. Nobody has to go hunting for that answer themselves — that's the whole
opportunity.

## Status

Early. The build order lives on the board; see `CLAUDE.md` for how the project
is put together.

## Themes

Schemes are adapted from
[mbadolato/iTerm2-Color-Schemes](https://github.com/mbadolato/iTerm2-Color-Schemes)
(MIT). Copyright in each individual theme belongs to its author.

`chm themes` opens an interactive picker in a TTY — arrow keys move, live
preview repaints the terminal as you go, enter applies, esc restores whatever
was active before you started picking. Piped, or with `--list`, it prints the
plain list instead: every pack `chm` can apply — the bundled ones plus
anything of your own — by the name a person reads, with a marker only on the
packs that aren't bundled:

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

A pack is a directory with a `pack.json` manifest. Drop one into
`%LOCALAPPDATA%\chameleon\themes\<your-pack-name>\` and it is selectable
immediately — no install, no registry, no restart.

The manifest's `slug` is what the pack loads as, and it is the only thing
that decides whether a pack overrides one already installed. **A pack whose
`slug` matches a bundled pack's replaces it; any other slug just adds to the
list.** `slug` is the one field worth getting right: it is never derived from
`name`, so naming your pack the same as a bundled theme does nothing on its
own — you have to declare the bundled pack's own slug. `chm themes` no longer
prints it (slugs stay typeable, just not shown — see "Naming a theme" below),
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
personal recolour, at
`%LOCALAPPDATA%\chameleon\themes\my-catppuccin\pack.json`:

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

## License

MIT
