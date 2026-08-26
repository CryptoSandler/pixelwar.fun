import { notFound } from "next/navigation";
import { Cabinet } from "../../../components/Cabinet";
import { PasteSignature } from "../../../components/PasteSignature";
import { PayWithWallet } from "../../../components/PayWithWallet";
import { queryOne } from "../../../lib/db";
import { classifyEndpoints } from "../../../lib/payments/cluster";
import { USDC_DECIMALS, USDC_MINT, paymentWallet, solanaRpcUrls } from "../../../lib/payments/config";
import { orderById } from "../../../lib/payments/orders";
import { warById } from "../../../lib/wars/lifecycle";

export const dynamic = "force-dynamic";

type TokenRow = {
  name: string;
  ticker: string;
  colour_slot: number;
  chain_id: string;
  contract: string;
};

/**
 * One order, and the wallet screen for paying it.
 *
 * Assembled on the server because two of the things a payer has to check —
 * the receiving wallet and the order's reference key — are not on
 * `GET /api/orders/[id]`: the first comes from this deployment's own
 * configuration, and the second is only useful to the browser that is about
 * to put it into a transaction. The status the payment screen waits on does
 * come from that endpoint, which is polled.
 */
export default async function OrderPage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const { orderId } = await params;

  const order = await orderById(orderId);
  if (!order) notFound();

  const wallet = paymentWallet();
  if (!wallet.ok) {
    console.error(`GET /join/${orderId}: ${wallet.reason}`);
    return (
      <Cabinet label="Payment">
        <section className="panel bevel p-6">
          <h1 className="text-[20px] font-medium">Payments are not available right now.</h1>
          <p className="mt-2 muted text-[13px]">
            Nothing has been charged. Try again shortly.
          </p>
        </section>
      </Cabinet>
    );
  }

  const [token, war] = await Promise.all([
    queryOne<TokenRow>(
      `SELECT name, ticker, colour_slot, chain_id, contract FROM war_tokens WHERE id = $1`,
      [order.warTokenId],
    ),
    warById(order.warId),
  ]);

  if (!token || !war) notFound();

  return (
    <Cabinet label="Payment">
      <section className="panel bevel flex flex-col gap-1 p-4">
        <h1 className="text-[20px] font-medium">
          {token.ticker} in {war.title}
        </h1>
        <p className="muted text-[13px]">
          Entry is paid once, in USDC on Solana. Painting is free for everyone afterwards, and any
          pixel can be painted over — the leaderboard counts what a token holds right now.
        </p>
      </section>

      <PayWithWallet
        // Classified here and passed as five words. The endpoint itself never
        // crosses to the browser — that is the whole point of `/api/rpc`, and
        // a network disclosure built by shipping the URL down would undo it
        // from the other side. What the payment screen needs is which cluster
        // this deployment settles on, and that is all it gets.
        proxyCluster={classifyEndpoints(solanaRpcUrls())}
        order={{
          id: order.id,
          status: order.status,
          amountUsd: order.amountUsd,
          payTo: wallet.address,
          mint: USDC_MINT,
          decimals: USDC_DECIMALS,
          reference: order.referencePubkey,
          expiresAt: order.expiresAt.toISOString(),
          payerPubkey: order.payerPubkey,
          token: {
            name: token.name,
            ticker: token.ticker,
            chainId: token.chain_id,
            contract: token.contract,
            colourSlot: token.colour_slot,
          },
        }}
      />

      {/* Only while there is still something to pay. An order that is already
          paid, expired or failed has nothing a signature could settle, and
          offering the form would invite somebody to spend a verification
          attempt proving that. */}
      {order.status === "pending" ? (
        <PasteSignature orderId={order.id} payerPubkey={order.payerPubkey} />
      ) : null}
    </Cabinet>
  );
}
