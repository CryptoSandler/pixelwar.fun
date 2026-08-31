import { redirect } from "next/navigation";
import { Cabinet } from "../../../components/Cabinet";
import { adminSessionLabel } from "../../../lib/admin";
import {
  assignableOrders,
  listOrphans,
  ORPHAN_PAGE_SIZE,
  type AssignableOrder,
  type Orphan,
} from "../../../lib/payments/orphans";

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
 * WHO CALLS `POST /api/admin/orphans/[id]/assign` AND
 * `POST /api/admin/orphans/[id]/discard`: the two forms on each open row
 * below. Plain HTML forms — no JavaScript, like the sign-in form, and for the
 * same reason. Neither form carries anything but ids and, for a discard, the
 * note; every decision about whether the action is allowed is made inside the
 * transaction, where it cannot be raced.
 *
 * **Assigning is the only act in this project that moves money on a human's
 * say-so.** It is deliberately the quietest control on the screen — a
 * secondary key, not the brass one — because the accent means "this is the
 * thing to do" (DESIGN.md I5) and moving somebody's money is not something
 * this page should be urging.
 *
 * Discarding moves nothing: it records that a human dealt with the payment —
 * refunded it, usually — and takes the row out of the queue. It is the more
 * common outcome of the two and is deliberately no louder, because "get this
 * off my list" is exactly the impulse that should not be encouraged by the
 * loudest control on the screen either. The note it requires is what makes a
 * closed row answerable months later.
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
 * What the assign and discard routes send back in `?error=`, said plainly.
 *
 * These mirror `AssignFailureReason` and `DiscardFailureReason` in
 * `settle.ts`. One map for both, because the two share `not_found` and
 * `already_resolved` and they mean the same thing on either path. Kept in the
 * page rather than passed through the redirect as prose, because a message in
 * a URL is a message anybody can put there.
 */
const ACTION_ERRORS: Record<string, string> = {
  no_order: "Pick an order before assigning.",
  note_required: "Say what happened to the money before discarding it.",
  note_too_long: "That note is too long. Keep it to a few lines.",
  not_found: "That filed payment no longer exists.",
  already_resolved: "That payment had already been resolved. Nothing was changed.",
  order_not_found: "That order does not exist.",
  order_not_assignable: "That order has already been paid, or can no longer be paid.",
  token_state_mismatch:
    "That order's colour reservation is not in the state the order claims. Do not assign to it.",
  signature_settled: "That signature has already paid for an order. Nothing was changed.",
  order_already_paid: "That order already holds a payment. Nothing was changed.",
  war_closed: "That war is no longer open for entry.",
  war_full: "That war has no seats left.",
  colour_taken: "That order's colour is held by someone else now.",
  contract_taken: "That token has already re-entered this war under a different colour.",
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

export default async function OrphansPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  // The same answer for signed out, expired, revoked, junk, and an unset
  // ADMIN_TOKEN: `adminSessionLabel` collapses all five to null, so there is
  // nothing here that could tell them apart even by accident.
  const label = await adminSessionLabel();
  if (!label) redirect("/admin");

  const params = await searchParams;
  const applied = params.applied === "1";
  const discarded = params.discarded === "1";
  const errorCode = typeof params.error === "string" ? params.error : null;

  const [orphans, orders] = await Promise.all([listOrphans(), assignableOrders()]);

  return (
    <Cabinet label="Unmatched payments">
      <section className="panel bevel flex flex-col gap-2 p-4">
        <h1 className="text-[20px] font-medium">Payments with no seat</h1>
        <p className="muted text-[13px]">
          Money that reached the payment wallet and could not be applied to a colour. Newest first.
          Amounts are SOL.
        </p>
        <p className="text-[13px]">
          Assigning one of these settles it against an order exactly as a payer&rsquo;s own payment
          would be settled — same colour rules, same one transaction. Check the fee payer on chain
          against whoever is asking before you do it.
        </p>
        <p className="text-[13px]">
          Discarding settles nothing and moves nothing: it records that you dealt with the payment,
          usually by refunding it, and takes the row out of the queue. The note is required, because
          it is the only thing that will answer &ldquo;what happened to this money&rdquo; later.
        </p>

        {applied ? (
          <p className="text-[13px]">The payment was applied. Its order is paid and its colour is live.</p>
        ) : null}
        {discarded ? (
          <p className="text-[13px]">
            The payment was marked handled. Nothing was settled and no colour changed — the row is
            out of the queue with your note on it.
          </p>
        ) : null}
        {errorCode ? (
          <p className="text-[13px]">
            {ACTION_ERRORS[errorCode] ?? "That action was refused. Nothing was changed."}
          </p>
        ) : null}
      </section>

      {orphans.length === 0 ? (
        <section className="panel bevel p-4">
          <p className="text-[13px]">Nothing is filed. Every payment so far found a seat.</p>
        </section>
      ) : (
        <ol className="flex flex-col gap-3">
          {orphans.map((orphan) => (
            <li key={orphan.id}>
              <OrphanCard orphan={orphan} orders={orders} />
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
function OrphanCard({ orphan, orders }: { orphan: Orphan; orders: AssignableOrder[] }) {
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

      {/*
        Received on its own. The filed row also carries `expected_base_units`,
        but that is the price of the order this payment was SUBMITTED against —
        not of the order an operator is about to pick. Shown side by side and
        labelled "Order price" it read as the comparison that matters, and it
        is the wrong comparison in exactly the case this screen exists for:
        reuniting a payment with a DIFFERENT order. So it moves down beside the
        order it actually describes, and the number to compare against lives in
        the picker, one line under the warning that nothing compares them for
        you.
      */}
      <Field label="Received">
        <span className="numeric text-[13px]">{orphan.receivedSol} SOL</span>
      </Field>

      <Field label="Why it was filed">
        <span className="text-[13px]">{REASONS[orphan.reason] ?? "Filed with no known reason."}</span>
        <span className="muted numeric text-[12px]">{orphan.reason}</span>
      </Field>

      {/*
        Who the CHAIN says paid, in both forms migration 002 records — the fee
        payer, and every wallet whose SOL balance went down. These are here so
        that assigning a payment does not mean trusting whoever is asking for
        it: an order id is something a claimant supplies, and this is not.
      */}
      <Field label="Fee payer on chain">
        {orphan.senderFeePayer ? (
          <span className="numeric text-[12px] break-all">{orphan.senderFeePayer}</span>
        ) : (
          <span className="muted text-[13px]">
            Not recorded. Look the signature up on chain to find who paid.
          </span>
        )}
      </Field>

      <Field label="Debited on chain">
        {orphan.senderDebited.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {orphan.senderDebited.map((entry) => (
              <li key={entry.owner} className="numeric text-[12px] break-all">
                {entry.owner} &mdash; {entry.amountSol} SOL
              </li>
            ))}
          </ul>
        ) : (
          <span className="muted text-[13px]">
            Not recorded. Only the verdicts that see a sender carry this; look the signature up on
            chain.
          </span>
        )}
      </Field>

      {orphan.orderId ? (
        <Field label="Submitted against order">
          <span className="numeric text-[12px] break-all">{orphan.orderId}</span>
          <span className="muted text-[13px]">
            That order&rsquo;s price was <span className="numeric">{orphan.expectedSol} SOL</span>.
          </span>
        </Field>
      ) : null}

      {orphan.appliedOrderId ? (
        <Field label="Applied to order">
          <span className="numeric text-[12px] break-all">{orphan.appliedOrderId}</span>
        </Field>
      ) : null}

      {orphan.resolvedAt ? (
        <Field label="Resolved">
          <span className="numeric text-[12px]">
            {stamp(orphan.resolvedAt)}
            {orphan.appliedBy ? ` by ${orphan.appliedBy}` : ""}
          </span>
          {orphan.resolutionNote ? (
            <span className="muted text-[13px]">{orphan.resolutionNote}</span>
          ) : null}
        </Field>
      ) : null}

      {open ? (
        <>
          <AssignForm orphanId={orphan.id} receivedSol={orphan.receivedSol} orders={orders} />
          <DiscardForm orphanId={orphan.id} />
        </>
      ) : null}
    </article>
  );
}

/**
 * Pick an order, and settle this payment against it.
 *
 * A `<select>` rather than a free-text order id: an operator typing a UUID by
 * hand into the one control in this project that moves money is a transposed
 * character away from paying the wrong order, and the settlement would happily
 * oblige because the id would be perfectly valid.
 *
 * The button is `.btn-secondary`, not `.btn-primary`. Brass means "this is the
 * action" (DESIGN.md I5), and a screen whose loudest element urges you to move
 * somebody's money is the wrong screen.
 */
function AssignForm({
  orphanId,
  receivedSol,
  orders,
}: {
  orphanId: string;
  receivedSol: string;
  orders: AssignableOrder[];
}) {
  if (orders.length === 0) {
    return (
      <p className="muted text-[13px]">
        No order can take a payment right now. Every order is paid, failed, or there are none.
      </p>
    );
  }

  return (
    <form
      action={`/api/admin/orphans/${orphanId}/assign`}
      method="post"
      className="flex flex-col gap-3"
    >
      {/*
        Said out loud because nothing enforces it: `settleAssignedPayment`
        deliberately does not compare the received amount to the chosen order's
        price. An underpayment can be assigned, and sometimes should be. What
        must not happen is an operator assuming a check ran.
      */}
      <p className="text-[13px]">
        The amount is not checked against the order you pick. Compare
        <span className="numeric"> {receivedSol} SOL</span> against the price in the list
        yourself, and assign anyway only if you mean to.
      </p>
      {/*
        `min-w-0` on the column and `w-full` on the control: a <select> sizes
        itself to its widest <option>, and these options carry a UUID, so
        without both it lays out wider than the panel it sits in and pushes the
        card off the page. Measured in a browser, not reasoned about.
      */}
      <label className="flex min-w-0 flex-col gap-1">
        <span className="section-label muted">Assign to order</span>
        <select name="orderId" required defaultValue="" className="field w-full px-3 py-2">
          <option value="" disabled>
            Pick an order
          </option>
          {orders.map((order) => (
            <option key={order.id} value={order.id}>
              {`${order.ticker} · slot ${order.colourSlot} · ${order.priceUsd} USD · ${order.status} · ${order.warTitle} · ${order.id}`}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="btn-secondary w-fit px-4 py-2">
        Assign
      </button>
    </form>
  );
}

/**
 * Mark this payment handled, and say what happened to it.
 *
 * The note is `required` on the field and required again in
 * `discardFiledPayment` — the attribute is the courtesy that stops a wasted
 * round trip, the server-side check is the one that holds, because a form
 * attribute is a suggestion to whatever is submitting the form.
 *
 * Also `.btn-secondary`. Neither control on this card is brass: the accent
 * means "this is the action to take" (DESIGN.md I5), and a screen that urges
 * an operator to clear rows off a money queue is urging the wrong thing.
 */
function DiscardForm({ orphanId }: { orphanId: string }) {
  return (
    <form
      action={`/api/admin/orphans/${orphanId}/discard`}
      method="post"
      className="flex flex-col gap-3"
    >
      <label className="flex min-w-0 flex-col gap-1">
        <span className="section-label muted">Discard with a note</span>
        {/*
          A hint line rather than a placeholder: a placeholder disappears the
          moment it is needed, and several browsers render one by quieting the
          field's own ink, which is the contrast rule DESIGN.md §9 exists to
          stop being decided by somebody else's stylesheet.
        */}
        <span className="muted text-[13px]">
          What happened to the money — the refund signature, or why nothing is owed.
        </span>
        <textarea name="note" required rows={2} maxLength={500} className="field w-full px-3 py-2" />
      </label>
      <button type="submit" className="btn-secondary w-fit px-4 py-2">
        Discard
      </button>
    </form>
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
