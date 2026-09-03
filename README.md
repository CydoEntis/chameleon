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

## License

MIT
