# pixelwar.fun

r/place for memecoin communities, run as timed wars.

A war has a start, an end, and a 200×200 canvas. Up to 24 tokens each hold one
colour, bought with a one-off USDC entry. Painting is free and needs no account
— a cooldown keyed to a signed cookie, the caller's address and their subnet is
what keeps it fair. Every pixel is attributed to a token, so the canvas is a
live scoreboard of which community turned up. At the deadline the board freezes
and the result is a ranking and a shareable image.

- Design: [`docs/superpowers/specs/2026-08-24-pixelwar-design.md`](docs/superpowers/specs/2026-08-24-pixelwar-design.md)
- Reference reading: [`docs/references.md`](docs/references.md)
- Vendored agent skills and how they are audited: [`docs/skills.md`](docs/skills.md)

## Running it locally

The database is Neon — there is no local Postgres. You need two connection
strings from one Neon project: the `production` branch for the app and a
`tests` branch the suite may truncate freely.

```bash
npm install
cp .env.example .env.local     # then fill it in; see the comments in that file
npm run db:up                  # applies migrations to both branches
npm run db:seed                # a demo war with six tokens, development only
npm run dev                    # http://localhost:3000
```

`.env.local` is gitignored and is the only place connection strings live.

## Tests

```bash
npm test
```

The suite runs against the real `tests` branch and takes about three minutes.
It refuses to start unless `TEST_DATABASE_URL` is set and points somewhere
other than `DATABASE_URL`, because every test begins by truncating every table.

**One suite at a time per branch.** Two suites — or a suite and a script —
against the same branch deadlock on that truncate, and it surfaces as an
intermittent failure in whatever test happened to be running, including tests
that touch no database at all.

## Verifying the UI

The suite does not cover the browser. Three defects in this project were
invisible to `tsc`, ESLint, `next build` and every test, and took a real
browser to find: a sidebar overlapping the paint button, a paint button that
could not be clicked with a mouse, and a canvas that painted the wrong pixel
after a window resize. Changes to `src/components/` or `src/hooks/` are not
verified until someone has driven them and looked at a screenshot.
