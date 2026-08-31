-- Admission is charged in SOL.
--
-- THE DECISION. Pixelwar took entry payments in USDC because a dollar price
-- is a dollar price and USDC is dollar-pegged. The owner has decided both
-- surfaces charge in SOL instead: the painter's registration already did, and
-- one denomination across the product means one verifier, one wallet, and one
-- thing to explain. It also separates us cleanly from bidoor.lol, which
-- shares the receiving wallet and takes its bids in USDC — see
-- docs/operations.md.
--
-- LAMPORTS, NOT A DECIMAL SOL AMOUNT. The chain moves whole lamports and
-- `registrations.lamports` already stores them; a NUMERIC here would be a
-- second representation of the same thing, and the conversion between them is
-- exactly where a rounding bug would take the wrong sum.
--
-- `entry_price_usd` IS LEFT ALONE AND STOPS BEING READ. It is not dropped:
-- every order already placed carries a dollar price, the rows in
-- `entry_orders.amount_usd` are the record of what those payers were actually
-- charged, and dropping the column would make that history unreadable. A
-- column nothing reads costs nothing; a rewritten history costs an argument
-- with somebody who paid.
ALTER TABLE wars ADD COLUMN entry_price_sol BIGINT;

-- The price a war charges, in lamports. Nullable ONLY so this migration can
-- apply to existing rows; `createWar` requires it, and a war with a NULL
-- price cannot take an order — `POST /api/orders` refuses rather than
-- charging zero, which is the failure mode a NOT NULL DEFAULT 0 would have
-- created silently.
--
-- No CHECK for a minimum. The floor is a product decision that will move, and
-- migration 008's own comment records what happens when a policy number gets
-- frozen into the schema: it becomes unreadable afterwards as to whether it
-- was a decision or an accident.
COMMENT ON COLUMN wars.entry_price_sol IS 'Admission price in lamports. NULL means the war predates SOL pricing and cannot take new orders.';

-- What THIS order was charged, in lamports, snapshotted at creation like
-- `amount_usd` was. The price is configuration and it moves; an order has to
-- say what it asked for rather than what the war currently asks.
ALTER TABLE entry_orders ADD COLUMN amount_lamports BIGINT;

-- `amount_usd` keeps its NOT NULL and its CHECK, so this column cannot simply
-- replace it while both exist. New orders write a placeholder dollar figure of
-- 0 — refused by that CHECK — so instead they write the war's old USD price if
-- it has one, and 1 otherwise. That is a record-keeping value, not a price
-- anybody is charged: `amount_lamports` is what the verifier compares against.
-- The next migration that has a reason to touch this table should drop
-- `amount_usd`'s NOT NULL rather than keep feeding it.
