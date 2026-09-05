# Attribution

Every layout under prompts/ is adapted from a theme in
[JanDeDobbeleer/oh-my-posh](https://github.com/JanDeDobbeleer/oh-my-posh) (MIT licence): half-life,
lambda, spaceship, avit, di4am0nd and bubblesline are all named after, and shaped after, the bundled
Oh My Posh theme of the same name.

Adaptation here is a rewrite, not a copy: every literal hex colour the upstream theme carries is
replaced with a reference to one of Chameleon's own six roles (`p:ground`, `p:body`, `p:accent`,
`p:muted`, `p:success`, `p:error`), following the pairing rule in CLAUDE.md — one side of every
segment's foreground/background pair is always `p:ground`. See src/palette/prompt-pack.ts for the
build-time lint that enforces this on every file in this directory, and CHM-46 for why: a layout
built against roles has nothing left to reverse-engineer, the class of defect that produced CHM-31,
CHM-37, CHM-40 and CHM-43.

Segment structure, icon choices and template text are adapted for legibility and brevity, not
reproduced byte for byte from the upstream JSON.

## Layouts

- half-life — single-line, no Nerd Font glyphs, the fallback for a terminal with no Nerd Font
  installed.
- lambda — minimal single-line prompt.
- spaceship — two-line prompt with git on the left, exit status and time on the right.
- avit — two-line prompt with a prompt glyph on its own second line.
- di4am0nd — three-block prompt, one diamond-cut segment per piece of context.
- bubblesline — powerline prompt, ten segments across two lines.

See the upstream project's own [LICENSE](https://github.com/JanDeDobbeleer/oh-my-posh/blob/main/LICENSE)
for the licence these are adapted under. Copyright in the original theme designs belongs to their
respective Oh My Posh contributors.
