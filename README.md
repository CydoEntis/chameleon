# Chameleon

One command retints your whole terminal — Windows Terminal colours, your
Oh My Posh prompt, and Herdr's UI — from a single palette. Nothing restarts.

```sh
npm i -g @cydoentis/chameleon

ch                     # pick a pack — arrow keys move, enter applies, esc cancels; prints the list instead when stdin isn't a TTY
ch catppuccin-dark     # apply by slug — see `ch list` for every slug you can use
ch 12                  # apply by row — the 12th line of `ch list`
ch dark / ch light     # flip mode, same family
ch next / ch prev      # cycle either way — bind them to keys
ch current             # print the active pack's slug ("--short" for just its name)
ch undo                # put it back
```

## Why

Changing how a terminal looks today means editing three unrelated config files
in three formats, and knowing which ones need a restart. All three tools reload
live. Nobody needs to restart anything — that's the whole opportunity.

## Status

Early. The build order lives on the board; see `CLAUDE.md` for how the project
is put together.

## Themes

Schemes are adapted from
[mbadolato/iTerm2-Color-Schemes](https://github.com/mbadolato/iTerm2-Color-Schemes)
(MIT). Copyright in each individual theme belongs to its author.

`ch list` shows every pack `ch` can apply — the bundled ones plus anything of
your own — and marks which is which:

```
catppuccin-dark  Catppuccin Mocha (mine)  (user)
catppuccin-light  Catppuccin Latte  (bundled)
dracula-dark  Dracula  (bundled)
```

### Drop-in packs

A pack is a directory with a `pack.json` manifest. Drop one into
`%LOCALAPPDATA%\chameleon\themes\<your-pack-name>\` and it is selectable
immediately — no install, no registry, no restart.

The manifest's `slug` is what the pack loads as, and it is the only thing
that decides whether a pack overrides one already installed. **A pack whose
`slug` matches a bundled pack's replaces it; any other slug just adds to the
list.** `slug` is the one field worth getting right: it is never derived from
`name`, so naming your pack the same as a bundled theme does nothing on its
own — you have to declare the bundled pack's own slug (the one `ch list`
prints in its first column). If you leave `slug` out entirely, Chameleon
derives one from `family` and the scheme's own light/dark appearance, the
same way a bundled pack's slug is built — and says so with a warning on
`ch list`, since a silently derived slug is exactly what makes an override
fail without any sign why.

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
the declared `slug` does — `ch list` now shows `catppuccin-dark` once,
marked `(user)`, with this pack's colours instead of the bundled one's.

A manifest that is missing `scheme`, has a malformed colour, or is not valid
JSON is reported by its directory name on `ch list` and skipped — every
other pack, bundled or user, still loads.

## License

MIT
