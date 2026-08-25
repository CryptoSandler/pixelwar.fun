import { queryOne } from "../../../../lib/db";
import { json, NO_STORE } from "../../../../lib/http";
import { orderById } from "../../../../lib/payments/orders";

export const dynamic = "force-dynamic";

type WarTokenRow = { ticker: string; colour_slot: number };

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  const order = await orderById(id);
  if (!order) return json({ error: "No such order." }, { status: 404, headers: NO_STORE });

  // The order's own row has everything except the ticker and colour a payer
  // is shown while they wait — those live on the war_tokens row it reserved.
  const token = await queryOne<WarTokenRow>(
    `SELECT ticker, colour_slot FROM war_tokens WHERE id = $1`,
    [order.warTokenId],
  );

  return json(
    {
      status: order.status,
      amountUsd: order.amountUsd,
      expiresAt: order.expiresAt.toISOString(),
      paidAt: order.paidAt ? order.paidAt.toISOString() : null,
      tokenTicker: token?.ticker ?? null,
      colourSlot: token?.colour_slot ?? null,
    },
    { headers: NO_STORE },
  );
}
