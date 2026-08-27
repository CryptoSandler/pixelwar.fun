import Link from "next/link";
import { AdminSignOut } from "../../components/AdminSignOut";
import { Cabinet } from "../../components/Cabinet";
import { adminSessionLabel } from "../../lib/admin";
import { unmatchedBacklog } from "../../lib/payments/orphans";

export const dynamic = "force-dynamic";

/**
 * The admin front door.
 *
 * WHO CALLS `POST /api/admin/session`: the form below. `POST` answers with a
 * 303 back to this page, and `?error=1` / `?error=locked` is how it says why —
 * so without this page a correct sign-in lands on a 404 and Task 1's route has
 * no caller at all. `adminSessionLabel` likewise: this is the server component
 * it was written for.
 *
 * A plain HTML form, no JavaScript. The route's own note says it, and it is
 * right: a login that needs client-side JavaScript to work is a login that
 * does not work when the JavaScript fails.
 *
 * Nothing here renders the token, the session id, or any part of either — the
 * label is the operator's name (`admin`), which is what `admin_sessions` stores
 * precisely so the secret never has to be handled again after sign-in.
 */
export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const label = await adminSessionLabel();
  const error = (await searchParams).error;

  if (label) {
    // On the link, not behind it. An operator who opens this page should not
    // have to click through to learn there is a queue — the whole failure
    // this batch is about is that the only way to find out was to go and
    // look.
    const backlog = await unmatchedBacklog();
    return (
      <Cabinet label="Admin">
        <section className="panel bevel flex flex-col gap-3 p-4">
          <h1 className="text-[20px] font-medium">Signed in</h1>
          <p className="muted text-[13px]">
            Operator <span className="numeric">{label}</span>.
          </p>
          {backlog.stale ? (
            <p role="status" className="readout bevel-in px-3 py-1.5 text-[13px]">
              The oldest unmatched payment has waited{" "}
              <span className="numeric">{backlog.oldestAgeHours}h</span>. That is somebody&apos;s
              money credited to nobody.
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <Link href="/admin/orphans" className="btn-primary px-4 py-2">
              Unmatched payments
              {backlog.open > 0 ? <span className="numeric"> ({backlog.open})</span> : null}
            </Link>
            <Link href="/admin/wars" className="btn-secondary px-4 py-2">
              Wars
            </Link>
            <AdminSignOut />
          </div>
        </section>
      </Cabinet>
    );
  }

  return (
    <Cabinet label="Admin">
      <section className="panel bevel flex flex-col gap-3 p-4">
        <h1 className="text-[20px] font-medium">Sign in</h1>

        {error === "locked" ? (
          <p className="text-[13px]">
            Too many failed attempts from this address. Wait a few minutes and try again.
          </p>
        ) : null}
        {error === "1" ? <p className="text-[13px]">That token was not accepted.</p> : null}

        <form action="/api/admin/session" method="post" className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="section-label">Admin token</span>
            <input
              type="password"
              name="token"
              autoComplete="current-password"
              required
              className="field px-3 py-2"
              // A token is a number-shaped secret in the sense that matters
              // here: it is read character by character, so it is monospaced
              // like every other fixed-width value on this surface.
              size={40}
            />
          </label>
          <button type="submit" className="btn-primary px-4 py-2">
            Sign in
          </button>
        </form>

        <p className="muted text-[13px]">
          Sign-in attempts are counted per address and locked out after repeated failures.
        </p>
      </section>
    </Cabinet>
  );
}
