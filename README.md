# Chameleon

One command retints your whole terminal — Windows Terminal colours, your
Oh My Posh prompt, and Herdr's UI — from a single palette. Nothing restarts.

```sh
npm i -g @cydoentis/chameleon

ch                 # pick a theme
ch tokyo-night     # apply by name
ch dark / ch light # flip mode, same family
ch next            # cycle — bind it to a key
ch undo            # put it back
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
github-dark  GitHub Dark Default  (bundled)
my-aardvark-dark  Aardvark Blue  (user)
```

### Drop-in packs

A pack is a directory with a `pack.json` manifest. Drop one into
`%LOCALAPPDATA%\chameleon\themes\<your-pack-name>\` and it is selectable
immediately — no install, no registry, no restart. A user pack with the same
name as a bundled one overrides it.

The manifest names the one colour scheme the pack adapts — the same 16 ANSI
colours plus background, foreground, cursor and selection every Windows
Terminal scheme carries — and an optional `family` for grouping it with a
light or dark sibling of its own. Chameleon computes everything else (which
colour plays which role, contrast repair, every target's payload) the same
way it does for a bundled pack, so a dropped-in theme is held to the same
contrast floors — see `CLAUDE.md`, "Never ship a colour that fails its
contrast floor".

`%LOCALAPPDATA%\chameleon\themes\aardvark-blue\pack.json`, adapted from
[Aardvark Blue](https://github.com/mbadolato/iTerm2-Color-Schemes/blob/master/windows-terminal/Aardvark%20Blue.json):

```json
{
  "family": "Aardvark Blue",
  "scheme": {
    "name": "Aardvark Blue",
    "black": "#191919",
    "red": "#aa342e",
    "green": "#4b8c0f",
    "yellow": "#dbba00",
    "blue": "#1370d3",
    "purple": "#c43ac3",
    "cyan": "#008eb0",
    "white": "#bebebe",
    "brightBlack": "#525252",
    "brightRed": "#f05b50",
    "brightGreen": "#95dc55",
    "brightYellow": "#ffe763",
    "brightBlue": "#60a4ec",
    "brightPurple": "#e26be2",
    "brightCyan": "#60b6cb",
    "brightWhite": "#f7f7f7",
    "background": "#102040",
    "foreground": "#dddddd",
    "cursorColor": "#007acc",
    "selectionBackground": "#bfdbfe"
  }
}
```

A manifest that is missing `scheme`, has a malformed colour, or is not valid
JSON is reported by its directory name on `ch list` and skipped — every
other pack, bundled or user, still loads.

## License

MIT
