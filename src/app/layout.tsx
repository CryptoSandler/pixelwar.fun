import type { Metadata } from "next";
import type { CSSProperties } from "react";
import { IBM_Plex_Mono, Jost } from "next/font/google";
import "./globals.css";
import { WalletProvider } from "../components/WalletProvider";
import { publicOrigin } from "../lib/config";
import {
  ACCENT,
  CHROME_SURFACES,
  DISABLED_FACE,
  DISABLED_INK,
  INK,
  INK_INVERSE,
  MUTED_INK,
  MUTED_INK_INVERSE,
} from "../lib/wars/chrome";

/**
 * Jost for everything that is words, IBM Plex Mono for everything that is a
 * number (DESIGN.md §3). Both through next/font/google, and no system stack
 * anywhere: a face that resolves differently per machine is a design that
 * does not exist.
 */
const jost = Jost({
  variable: "--font-jost",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

/**
 * The chrome palette, handed to CSS.
 *
 * Set here rather than written into globals.css so that `chrome.ts` — the
 * file DESIGN.md's invariants are tested against — is the only place these
 * values exist. A hex in the stylesheet would be a second copy that no test
 * polices, and the first thing to drift.
 *
 * `INK` and `INK_INVERSE` are not new colours — they are the header and panel
 * surfaces read back as text. The two that are colours of their own are
 * `MUTED_INK` and `MUTED_INK_INVERSE`, one per polarity, and they are how
 * quiet text is expressed here: **no text in this application, and no control
 * carrying text, is quieted with `opacity` or a `filter` any more**, because
 * compositing turns a measured contrast into an unmeasured one.
 *
 * That sentence was written one batch before it was true. Six composited sites
 * survived it in the board UI — the last of them a keyboard hint — and they
 * were replaced with named colours in the same commit this comment changed.
 * The rule now describes the tree rather than the intention.
 *
 * What actually renders, at full strength, since that is the only claim worth
 * making: `INK` reads 11.51:1 on a panel, 8.40:1 on the readout and 7.20:1 on
 * the surround; `MUTED_INK` reads 7.81:1 on the panel and control faces, the
 * only two surfaces `MUTED_INK_SURFACES` declares it for; `DISABLED_INK`
 * reads 3.57:1 on those same faces, and is drawn nowhere else — the board's
 * one disabled control is the Paint button, whose label carries the cooldown
 * countdown and is quiet rather than out of reach; `MUTED_INK_INVERSE` reads
 * 9.70:1 on the board's dark shell and 7.26:1 in the board well;
 * `DISABLED_FACE` carries `INK` at 4.85:1. DESIGN.md §9 asks for 8:1 in the
 * readout and 7:1 for body text, and I6 tests every one of these numbers
 * rather than trusting this comment. Which surface a class is *used* on is not
 * something a unit test can see — see I6's own caveat.
 */
const chrome = {
  "--chrome-surround": CHROME_SURFACES.surround,
  "--chrome-panel": CHROME_SURFACES.panel,
  "--chrome-control": CHROME_SURFACES.control,
  "--chrome-readout": CHROME_SURFACES.readout,
  "--chrome-header": CHROME_SURFACES.header,
  "--chrome-board": CHROME_SURFACES.board,
  "--chrome-accent": ACCENT,
  "--chrome-ink": INK,
  "--chrome-ink-muted": MUTED_INK,
  "--chrome-ink-muted-inverse": MUTED_INK_INVERSE,
  "--chrome-ink-disabled": DISABLED_INK,
  "--chrome-disabled-face": DISABLED_FACE,
  "--chrome-ink-inverse": INK_INVERSE,
} as CSSProperties;

export const metadata: Metadata = {
  /**
   * What every relative URL in this application's metadata resolves against.
   *
   * WITHOUT IT THE SHARE CARDS SILENTLY HAVE NO IMAGE. `openGraph.images` is
   * written as `/og/<slug>` on the pages that have one, and a crawler is not
   * on our origin — a relative `og:image` resolves against nothing at its end,
   * so the card unfurls as text. Next warns about a missing `metadataBase` in
   * development and falls back to localhost, which is a URL that works on the
   * developer's machine and nowhere else: the failure looks fine locally and
   * only exists in production, which is the worst shape a failure can take.
   *
   * `publicOrigin` resolves SITE_URL first and the deployment's own hostname
   * after it — see `lib/config.ts` for why the production hostname beats the
   * per-deployment one.
   */
  metadataBase: publicOrigin(),

  title: "pixelwar.fun",
  /**
   * Deliberately promises nothing about price or architecture.
   *
   * This used to read "Up to 24 memecoin tokens each hold one colour — paint
   * for free, no account, no wallet." Two problems, and the second is the one
   * that matters. The first half stopped being true when the palette was
   * freed: colours belong to nobody now. The second half is a ONE-WAY
   * PROMISE, published — "free", "no account", "no wallet" are three
   * commitments the product cannot walk back without being caught having
   * changed its terms, and all three are live product questions.
   *
   * So the wording is neutral by design: true today, true if painting stays
   * free forever, and true if a future war asks a painter to connect a wallet
   * to prove they hold a token. Nothing here forbids that and nothing
   * promises it. See CLAUDE.md, "Decisions with a door".
   */
  description:
    "A timed war on a shared 200×200 canvas. Communities compete for territory; painting takes a one-time registration.",
  /**
   * Layer 2 of the pre-launch noindex. See `src/app/robots.ts` for why there
   * are three of these and what each one covers; the short version is that
   * this is the only layer that reaches a crawler which fetched the page
   * anyway, and it reaches HTML documents only.
   *
   * `nofollow` alongside `noindex` because the join and admin paths are
   * reachable from here, and there is no reason to hand a crawler the map
   * while asking it not to read the destination.
   *
   * Remove this block, `robots.ts`, and the `X-Robots-Tag` header in
   * `next.config.ts` together at launch.
   */
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${jost.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col" style={chrome}>
        <WalletProvider>{children}</WalletProvider>
      </body>
    </html>
  );
}
