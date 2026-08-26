import type { Metadata } from "next";
import type { CSSProperties } from "react";
import { IBM_Plex_Mono, Jost } from "next/font/google";
import "./globals.css";
import { WalletProvider } from "../components/WalletProvider";
import { ACCENT, CHROME_SURFACES } from "../lib/wars/chrome";

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
 * The two ink values are not new colours: dark ink is the header surface and
 * light ink is the panel surface, reused as text. Body text on the surround
 * lands at 7.2:1 and on a panel at 11.5:1, readout text at 8.4:1 — the
 * thresholds DESIGN.md §9 asks for.
 */
const chrome = {
  "--chrome-surround": CHROME_SURFACES.surround,
  "--chrome-panel": CHROME_SURFACES.panel,
  "--chrome-control": CHROME_SURFACES.control,
  "--chrome-readout": CHROME_SURFACES.readout,
  "--chrome-header": CHROME_SURFACES.header,
  "--chrome-board": CHROME_SURFACES.board,
  "--chrome-accent": ACCENT,
  "--chrome-ink": CHROME_SURFACES.header,
  "--chrome-ink-inverse": CHROME_SURFACES.panel,
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
