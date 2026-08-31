-- An order stops pretending to have a dollar price.
--
-- Migration 015 moved admission to SOL and left `amount_usd` NOT NULL, so
-- every new order wrote a 1 into it — a number nobody chose, nobody charged
-- and nobody could read as anything. A filler value in a money column is
-- worse than an empty one: it is indistinguishable from a real price, and the
-- first person to sum that column gets an answer that looks plausible.
--
-- NULL now means what it should: this order was never priced in dollars.
--
-- ROWS WITH A REAL DOLLAR PRICE ARE LEFT EXACTLY AS THEY ARE. They were true
-- when they were written — those payers really were asked for that many
-- dollars — and rewriting them to NULL would destroy the only record of it.
-- This migration changes what FUTURE orders may say, not what past ones did.
--
-- The `amount_usd > 0` CHECK stays and needs no change: a CHECK evaluates to
-- unknown on NULL, and unknown passes. So the constraint still means "if
-- there is a dollar price, it is positive", which is exactly right.
ALTER TABLE entry_orders ALTER COLUMN amount_usd DROP NOT NULL;

COMMENT ON COLUMN entry_orders.amount_usd IS
  'What this order was asked for in whole dollars, or NULL for orders priced in SOL (migration 015 onward). Never a filler value.';
