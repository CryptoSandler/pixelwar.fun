-- tooManyOrders (src/app/api/orders/route.ts) counts entry_orders rows by
-- ip_hash within a trailing window on every single POST /api/orders. Without
-- an index matching that filter, this is a sequential scan over a table that
-- only ever grows, across every war, forever.

CREATE INDEX entry_orders_ip_hash_created_at ON entry_orders (ip_hash, created_at);
