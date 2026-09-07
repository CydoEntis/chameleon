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

Two families are not in it and come from their own pinned sources. Each pack's
own manifest carries the attribution it was built from, so nothing here is
credited to a collection it did not come from.

- **PaperColor** — [tomotargz/papercolor-terminal-app](https://github.com/tomotargz/papercolor-terminal-app) (MIT), pinned to commit `3b7a1c9ecc0642d355a2d73ba899a1ac2d18a0c7`
- **TangoTango** — [juba/color-theme-tangotango](https://github.com/juba/color-theme-tangotango) (GPL-3.0-or-later), pinned to commit `6202d4a19ac1def1b2596f1906c4524dd7303563`

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

## Families

- Ayu
- Catppuccin
- Dracula
- Everforest
- GitHub
- Gruvbox
- Jellybeans
- Kanagawa
- Monokai
- Night Owl
- Nord
- One Half
- PaperColor
- Rosé Pine
- Shades Of Purple
- Solarized
- TangoTango
- Tokyo Night
