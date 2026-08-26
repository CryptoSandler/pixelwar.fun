import type { Metadata } from "next";
import type { CSSProperties } from "react";
import { IBM_Plex_Mono, Jost } from "next/font/google";
import "./globals.css";
import { WalletProvider } from "../components/WalletProvider";
import { ACCENT, CHROME_SURFACES, INK, INK_INVERSE, MUTED_INK } from "../lib/wars/chrome";

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
 * surfaces read back as text. `MUTED_INK` is a colour of its own, and it is
 * how quiet text is expressed here: nothing in this application is quieted
 * with opacity, because compositing turns a measured contrast into an
 * unmeasured one.
 *
 * What actually renders, at full strength, since that is the only claim worth
 * making: `INK` reads 11.51:1 on a panel, 8.40:1 on the readout and 7.20:1 on
 * the surround; `MUTED_INK` reads 7.81:1 on a panel and is declared for no
 * other surface (`MUTED_INK_SURFACES`). DESIGN.md §9 asks for 8:1 in the
 * readout and 7:1 for body text, and I6 tests every one of these numbers
 * rather than trusting this comment.
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
  "--chrome-ink-inverse": INK_INVERSE,
} as CSSProperties;

export const metadata: Metadata = {
  title: "pixelwar.fun",
  description:
    "A timed war on a shared 200x200 canvas. Up to 24 memecoin tokens each hold one colour — paint for free, no account, no wallet.",
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
