import { redirect } from "next/navigation";
import { Cabinet } from "../../../components/Cabinet";
import { adminSessionLabel } from "../../../lib/admin";
import { listOrphans, ORPHAN_PAGE_SIZE, type Orphan } from "../../../lib/payments/orphans";

export const dynamic = "force-dynamic";

/**
 * The unmatched-payment queue, for a human.
 *
 * Money that reached our wallet and could not be applied to a seat is filed to
 * `unmatched_payments`, and the payer is told to contact support with their
 * transaction signature. Until this screen existed, support could not look
 * that signature up without a psql prompt. This is the whole point of the
 * batch.
 *
 * Read directly on the server rather than through `GET /api/admin/orphans`: a
 * server component sharing the request has the rows on first paint, where a
 * fetch would need an absolute URL and the caller's cookie forwarded by hand
 * to reach an endpoint that would then read the same table. The JSON endpoint
 * exists for the operator who has no browser.
 *
 * WHAT IS NOT HERE: assigning a filed payment to an order. That is the only
 * path in this project where money would move on a human's say-so, and it must
 * inherit `settlePayment`'s guarantees whole rather than grow a second
 * settlement beside them. `settlePayment` cannot be reused as-is — it requires
 * a `VerifyResult` that only a chain round trip against THIS order can produce
 * and that no orphan can satisfy, and for eight of the eleven reasons a row
 * can carry the signature is already claimed in `consumed_signatures`. Written
 * up in `.superpowers/sdd/2026-08-26-admin-orphans/task-2-report.md` §1, and
 * said on screen below rather than hidden behind a button that cannot work.
 */

/**
 * The reason codes `fileUnmatched` writes, in the operator's language.
 *
 * The raw code is still shown beside the sentence: it is what an operator
 * greps the logs for, and an unrecognised code must never render as nothing.
 * Anything missing here falls through to the code alone.
 */
const REASONS: Record<string, string> = {
  order_already_paid: "The order had already been paid when this arrived.",
  order_failed: "The order could no longer be paid when this arrived.",
  token_state_mismatch: "The order's colour reservation was not in the state the order claimed.",
  colour_taken: "Someone else claimed the colour before this payment arrived.",
  contract_taken: "The token had already re-entered the war under a different colour.",
  war_full: "The war's seats filled before this payment arrived.",
  war_closed: "The war was no longer open for entry.",
  late_confirm_past_grace: "Confirmed too long after the reservation window closed.",
  wrong_payer: "Paid from a wallet other than the one the order was opened with.",
  insufficient_amount: "Less than the entry price arrived.",
  outside_bid_window: "The transfer did not land inside the order's payment window.",
};

/**
 * ISO-8601 UTC, deliberately.
 *
 * An operator reads this beside a block explorer, and an unambiguous
 * timestamp is what makes the two comparable. A localised string would also be
 * wrong twice over: rendered on the server it carries the server's locale and
 * zone, not the reader's.
 */
function stamp(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

export default async function OrphansPage() {
  // The same answer for signed out, expired, revoked, junk, and an unset
  // ADMIN_TOKEN: `adminSessionLabel` collapses all five to null, so there is
  // nothing here that could tell them apart even by accident.
  const label = await adminSessionLabel();
  if (!label) redirect("/admin");

  const orphans = await listOrphans();

  return (
    <Cabinet label="Unmatched payments">
      <section className="panel bevel flex flex-col gap-2 p-4">
        <h1 className="text-[20px] font-medium">Payments with no seat</h1>
        <p className="muted text-[13px]">
          Money that reached the payment wallet and could not be applied to a colour. Newest first.
          Amounts are USDC.
        </p>
        <p className="text-[13px]">
          Assigning one of these to an order is not built yet. It would be the only place in this
          project where money moves on a human&rsquo;s say-so, so it has to reuse the same
          settlement a payer gets — and that code cannot be reused as it stands. Refunds are
          handled off-platform until that is decided.
        </p>
      </section>

      {orphans.length === 0 ? (
        <section className="panel bevel p-4">
          <p className="text-[13px]">Nothing is filed. Every payment so far found a seat.</p>
        </section>
      ) : (
        <ol className="flex flex-col gap-3">
          {orphans.map((orphan) => (
            <li key={orphan.id}>
              <OrphanCard orphan={orphan} />
            </li>
          ))}
        </ol>
      )}

      {orphans.length === ORPHAN_PAGE_SIZE ? (
        <section className="panel bevel p-4">
          <p className="muted text-[13px]">
            Showing the newest <span className="numeric">{ORPHAN_PAGE_SIZE}</span>. Older rows are
            in <span className="numeric">unmatched_payments</span>.
          </p>
        </section>
      ) : null}
    </Cabinet>
  );
}

/**
 * One filed payment.
 *
 * A stack of labelled lines rather than a table row: a Solana signature is 88
 * characters, and at this width a table means either a horizontal scrollbar or
 * a truncation that hides the very value the operator came to copy. Every
 * number, signature, address and date carries `.numeric` — IBM Plex Mono,
 * tabular — per DESIGN.md §3. Quiet text is `.muted`, a named colour on a
 * panel face; nothing here is quieted with `opacity` or a `filter`.
 */
function OrphanCard({ orphan }: { orphan: Orphan }) {
  const open = orphan.status === "open";

  return (
    <article className="panel bevel flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="section-label">{stamp(orphan.createdAt)}</span>
        <span className="section-label">{open ? "Open" : orphan.status}</span>
      </div>

      <Field label="Signature">
        <span className="numeric text-[12px] break-all">{orphan.signature}</span>
      </Field>

      <div className="flex flex-wrap gap-6">
        <Field label="Received">
          <span className="numeric text-[13px]">{orphan.receivedUsdc} USDC</span>
        </Field>
        <Field label="Order price">
          <span className="numeric text-[13px]">{orphan.expectedUsdc} USDC</span>
        </Field>
      </div>

      <Field label="Why it was filed">
        <span className="text-[13px]">{REASONS[orphan.reason] ?? "Filed with no known reason."}</span>
        <span className="muted numeric text-[12px]">{orphan.reason}</span>
      </Field>

      {orphan.senderFeePayer ? (
        <Field label="Fee payer on chain">
          <span className="numeric text-[12px] break-all">{orphan.senderFeePayer}</span>
        </Field>
      ) : (
        <Field label="Fee payer on chain">
          <span className="muted text-[13px]">
            Not recorded. Look the signature up on chain to find who paid.
          </span>
        </Field>
      )}

      {orphan.orderId ? (
        <Field label="Submitted against order">
          <span className="numeric text-[12px] break-all">{orphan.orderId}</span>
        </Field>
      ) : null}

      {orphan.appliedOrderId ? (
        <Field label="Applied to order">
          <span className="numeric text-[12px] break-all">{orphan.appliedOrderId}</span>
        </Field>
      ) : null}

      {orphan.resolvedAt ? (
        <Field label="Resolved">
          <span className="numeric text-[12px]">{stamp(orphan.resolvedAt)}</span>
          {orphan.resolutionNote ? (
            <span className="muted text-[13px]">{orphan.resolutionNote}</span>
          ) : null}
        </Field>
      ) : null}
    </article>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="section-label muted">{label}</span>
      {children}
    </div>
  );
}
