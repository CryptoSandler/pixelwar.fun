# The two typefaces, vendored

These are the SAME two faces `app/layout.tsx` loads through
`next/font/google` — Jost and IBM Plex Mono, DESIGN.md §3. They are duplicated
here as `.ttf` for one reason: `ImageResponse` renders with Satori, which
accepts `ttf`, `otf` and `woff` and NOT the `woff2` that `next/font` emits.
There is no way to reach the build's own copies, so the share card either gets
its own copy of the real faces or renders in something else.

**Rendering the card in something else was the alternative and it was
refused.** `next/og` bundles Geist and would have used it with no `fonts`
option at all — zero bytes, zero work, and a share card in a typeface this
product does not use. DESIGN.md §3 opens with *"No system font stacks: a face
that resolves differently per machine is a design that does not exist"*, and
the share card is the single most-reproduced image this site emits. A third
face on it is the same defect one step further out.

**These are STATIC instances, and that is not a style choice.** The first
attempt vendored Jost's variable `.ttf` — the file `github.com/google/fonts`
ships — and Satori threw inside `parseFvarAxis` before rendering a pixel: its
font parser cannot read an `fvar` table. The card 500s, totally, at request
time. `share-card.test.ts` renders a real PNG for exactly this reason; no
amount of testing `board-png.ts` would have found it, because nothing else in
this project ever loads that route.

Two Jost weights, 400 and 500, so the card can use DESIGN.md §3's real type
scale. IBM Plex Mono is the static Regular, because §3's rule that every
number is monospaced is not waived by the surface being a picture.

Both are SIL Open Font License 1.1, whose terms require the licence to travel
with the files. It is reproduced in full in `OFL.txt` beside them, and the
attribution is recorded in DESIGN.md §10.

Sources, both from `github.com/google/fonts`, fetched 2026-09-02:

- `fonts.gstatic.com/s/jost/v20/...jJQVG.ttf` (weight 400) -> `Jost-Regular.ttf`
- `fonts.gstatic.com/s/jost/v20/...RJQVG.ttf` (weight 500) -> `Jost-Medium.ttf`
- `ofl/ibmplexmono/IBMPlexMono-Regular.ttf`                -> `IBMPlexMono-Regular.ttf`

The two Jost files come from the Google Fonts CSS API rather than from the
repository, because the repository only ships the variable font and the API is
where the static instances live.
