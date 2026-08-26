import Link from "next/link";

/**
 * The cabinet around a screen: a header bar carrying the wordmark, and a
 * column that the content sits in.
 *
 * The wordmark is brass, which is one of exactly three places the accent is
 * allowed to appear — the primary button and the selected swatch are the
 * other two (DESIGN.md I5). Nothing that stands for a token is ever this
 * colour.
 */
export function Cabinet({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-[720px] flex-col gap-4 p-4 sm:p-6">
      <header className="header-bar bevel flex items-center justify-between px-4 py-3">
        <Link
          href="/"
          className="text-[16px] font-medium tracking-[0.14em]"
          style={{ color: "var(--chrome-accent)" }}
        >
          PIXELWAR.FUN
        </Link>
        <span className="section-label">{label}</span>
      </header>
      {children}
    </main>
  );
}
