# Attribution

Most packs under themes/ are adapted from a scheme in
[mbadolato/iTerm2-Color-Schemes](https://github.com/mbadolato/iTerm2-Color-Schemes) (MIT), pinned to
commit `752a9c079396cc9939b86e893578ed81e80c140f`. Copyright in each individual theme belongs to its
own author; see LICENSE in this directory for the upstream collection's licence.

Colours here are not byte-for-byte the upstream scheme — Chameleon's contrast
engine (src/palette/) measures every role against its own floor and repairs
whatever fails before a pack ships. See CLAUDE.md, "Never ship a colour that
fails its contrast floor".

## Sources outside that collection

Four families are not in it and come from their own pinned sources. Each pack's
own manifest carries the attribution it was built from, so nothing here is
credited to a collection it did not come from.

- **PaperColor** — [tomotargz/papercolor-terminal-app](https://github.com/tomotargz/papercolor-terminal-app) (MIT), pinned to commit `3b7a1c9ecc0642d355a2d73ba899a1ac2d18a0c7`
- **TangoTango** — [juba/color-theme-tangotango](https://github.com/juba/color-theme-tangotango) (GPL-3.0-or-later), pinned to commit `6202d4a19ac1def1b2596f1906c4524dd7303563`
- **Cyberdream** — [scottmckendry/cyberdream.nvim](https://github.com/scottmckendry/cyberdream.nvim) (MIT), pinned to commit `39e1fda12c0704e01029b286a4c7e77e33a0c5cd`
- **Bamboo** — [ribru17/bamboo.nvim](https://github.com/ribru17/bamboo.nvim) (MIT), pinned to commit `1309bc88bffcf1bedc3e84e7fa9004de93da774a`

The PaperColor packs are decoded from a Terminal.app port rather than from
NLKNguyen's Vim theme, which has no usable ANSI mapping of its own. The port
is not taken on trust: every one of its 16 slots is checked against the
vendored PaperColor.vim's own `color00`..`color15` at build time. See
vendor/papercolor-theme/SOURCE.txt and vendor/papercolor-terminal-app/SOURCE.txt.

The TangoTango pack takes its normal 8 ANSI slots and its background,
foreground, cursor and selection from juba's Emacs theme, which is
**GPL-3.0-or-later** where Chameleon itself is MIT — those bare colour values
are the whole of what is used from it. Its bright 8, which the Emacs theme does
not define, come from "Builtin Tango Dark" in the MIT collection above. See
vendor/tangotango/SOURCE.txt.

The Cyberdream and Bamboo packs are read from each theme's own Alacritty
export, published by the theme itself rather than by a third party. That is
why neither needs the kind of verification pass PaperColor does: the export
*is* upstream, and its 16 ANSI slots are authoritative and correctly named.
Alacritty carries no cursor colour unless a theme sets one and neither does,
so the cursor is seeded from foreground; Bamboo sets no selection colour
either, so that is seeded from its background and resolved from the accent.
See vendor/cyberdream-nvim/SOURCE.txt and vendor/bamboo-nvim/SOURCE.txt.

## Families

- Aura
- Ayu
- Bamboo
- Catppuccin
- Challenger Deep
- Cobalt2
- Cyberdream
- Doom One
- Dracula
- Embark
- Everblush
- Everforest
- Flexoki
- GitHub
- Gruvbox
- Iceberg
- Jellybeans
- Kanagawa
- Melange
- Modus Vivendi
- Monokai
- Moonfly
- Night Owl
- Nightfox
- Nord
- One Half
- PaperColor
- Rosé Pine
- Seoulbones
- Shades Of Purple
- Snazzy
- Solarized
- Sonokai
- Synthwave
- TangoTango
- Terafox
- Tokyo Night
- Vesper
- Zenbones
