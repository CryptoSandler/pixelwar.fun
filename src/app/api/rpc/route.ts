import { identify, json, NO_STORE } from "../../../lib/http";
import { solanaRpcUrls } from "../../../lib/payments/config";

export const dynamic = "force-dynamic";

/**
 * A server-side proxy onto the configured Solana RPC endpoint.
 *
 * Publishing that endpoint to the browser hands a paid provider's key to
 * anyone who opens dev tools, and widening the site's CSP `connect-src` past
 * `'self'` so the browser could call it directly would weaken the CSP for
 * every page. This route is what lets the wallet adapter build and send a
 * transaction without either of those: the endpoint stays server-side, and
 * the browser only ever talks to `'self'`.
 *
 * A whitelist that forwards a call and only discards the *answer* it does
 * not like is not a whitelist — a caller could still spend a paid request
 * against our provider on any method it wants. Every rejection below
 * happens before `forward()` is ever called.
 */

/**
 * The only methods the wallet flow needs, and the only ones this proxy will
 * ever forward:
 *
 * - getLatestBlockhash: every transaction needs a recent blockhash.
 * - getAccountInfo: does the payer's USDC account exist.
 * - getTokenAccountsByOwner: find it.
 * - getMinimumBalanceForRentExemption: only if a token account must be created.
 * - sendTransaction: submit the signed transfer.
 * - getSignatureStatuses: show "confirming..." before the server verifies.
 *
 * Nothing else — not getProgramAccounts, not getBlock, not anything that
 * could turn this into a general-purpose RPC relay for someone else's app.
 */
const ALLOWED_METHODS = new Set<string>([
  "getLatestBlockhash",
  "getAccountInfo",
  "getTokenAccountsByOwner",
  "getMinimumBalanceForRentExemption",
  "sendTransaction",
  "getSignatureStatuses",
]);

/**
 * JSON-RPC allows a batch: an array of call objects, not just one. A
 * whitelist that only inspects `body.method` waves an entire batch through
 * on the strength of never looking past its first element. Both shapes are
 * normalised to an array here, and the whole request is rejected if any one
 * member names a method outside the whitelist — a batch is one request, not
 * several independent ones, and this proxy does not forward part of it.
 */
function isWhitelistedRequest(payload: unknown): boolean {
  const calls = Array.isArray(payload) ? payload : [payload];
  if (calls.length === 0) return false;
  return calls.every(
    (call) =>
      typeof call === "object" &&
      call !== null &&
      typeof (call as { method?: unknown }).method === "string" &&
      ALLOWED_METHODS.has((call as { method: string }).method),
  );
}

/**
 * A JSON-RPC call for one of the whitelisted methods comfortably fits in a
 * few hundred bytes; the largest, `sendTransaction`, carries a base64-encoded
 * signed transaction under Solana's own ~1232-byte transaction limit, which
 * base64 and JSON framing inflate to a little under 2 KB. This caps the body
 * well above a full batch of every whitelisted method at once, with room to
 * spare, while still refusing anything shaped like an attempt to push an
 * unrelated payload through this endpoint.
 */
const MAX_BODY_BYTES = 16_384;

type CappedBody = { ok: true; text: string } | { ok: false };

/**
 * Reads the request body up to `maxBytes`, refusing anything larger without
 * ever buffering more than that much of it.
 *
 * A `content-length` check alone is not enough: a client can omit it (a
 * streamed/chunked body has none) or simply lie. So the declared size is
 * checked first, as a fast rejection, and the stream itself is also capped
 * while reading it — the same amount is refused either way, but only the
 * second check is trustworthy on its own.
 */
async function readCappedBody(request: Request, maxBytes: number): Promise<CappedBody> {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) return { ok: false };

  const body = request.body;
  if (!body) return { ok: true, text: "" };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { ok: false };
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(merged) };
}

/**
 * Calls allowed per `ip_hash` inside the window below.
 *
 * A function, not a constant, for the same reason as `orderRateLimit` in
 * `orders/route.ts`: a module-level constant freezes the value at import
 * time, which a test cannot then dial down without a process restart.
 */
function rpcRateLimit(): { max: number; windowMs: number } {
  const max = Number.parseInt(process.env.RPC_RATE_LIMIT_MAX ?? "", 10);
  const windowSeconds = Number.parseInt(process.env.RPC_RATE_LIMIT_WINDOW_SECONDS ?? "", 10);
  return {
    max: Number.isInteger(max) && max > 0 ? max : 120,
    windowMs: (Number.isInteger(windowSeconds) && windowSeconds > 0 ? windowSeconds : 60) * 1000,
  };
}

/**
 * In-memory rather than the DB-backed pattern `tooManyOrders` uses in
 * `orders/route.ts`. Starting an order is a rare, deliberate action worth a
 * database round trip to rate-limit precisely; an RPC call happens many
 * times over the course of a single payment (a blockhash, an account
 * lookup, a send, a few status polls), and a DB write on every one of them
 * would make this proxy itself the bottleneck it exists to protect a paid
 * provider from.
 *
 * The trade this accepts: the bucket resets on a cold start, and a caller
 * spread across several instances gets a bucket per instance rather than one
 * shared bucket. That is an acceptable gap for a defence-in-depth cap on
 * sustained abuse from one address — it is not what stops an unwhitelisted
 * method or an unbounded body from reaching the provider; the checks above
 * do that, and they are exact.
 */
const rpcBuckets = new Map<string, { count: number; windowStart: number }>();

/** Bounds `rpcBuckets`' size by sweeping windows that have already lapsed. */
function pruneStaleBuckets(windowMs: number, now: number): void {
  if (rpcBuckets.size < 5_000) return;
  for (const [key, bucket] of rpcBuckets) {
    if (now - bucket.windowStart >= windowMs) rpcBuckets.delete(key);
  }
}

function tooManyRpcCalls(ipHash: string): boolean {
  const { max, windowMs } = rpcRateLimit();
  const now = Date.now();
  pruneStaleBuckets(windowMs, now);

  const bucket = rpcBuckets.get(ipHash);
  if (!bucket || now - bucket.windowStart >= windowMs) {
    rpcBuckets.set(ipHash, { count: 1, windowStart: now });
    return false;
  }
  bucket.count += 1;
  return bucket.count > max;
}

type JsonRpcId = string | number | null;

/**
 * A recognised JSON-RPC 2.0 response body: exactly one of `result` or
 * `error`, per spec — never both, never neither. Anything else (a bare
 * value, an object with neither key, an object with both) is not a shape
 * this proxy will pass an opinion on; it is treated as an upstream failure.
 */
function isJsonRpcResponse(value: unknown): value is { result?: unknown; error?: unknown } {
  if (typeof value !== "object" || value === null) return false;
  const hasResult = "result" in value;
  const hasError = "error" in value;
  return hasResult !== hasError;
}

/**
 * A single upstream failure, in whatever form (a thrown fetch, a non-2xx
 * status, an unparseable body, a shape this proxy does not recognise),
 * rebuilt as our own generic JSON-RPC error entry. The code is fixed and
 * arbitrary (outside the range Solana's own node reserves) precisely
 * because it carries no information about what actually went wrong upstream
 * — that is the point.
 */
const GENERIC_UPSTREAM_ERROR = {
  code: -32000,
  message: "The Solana network could not complete this request. Try again in a moment.",
} as const;

/** Every id in `ids`, answered with the same generic failure. */
function failureBody(ids: JsonRpcId[], isBatch: boolean): unknown {
  const entries = ids.map((id) => ({ jsonrpc: "2.0", id, error: GENERIC_UPSTREAM_ERROR }));
  return isBatch ? entries : entries[0];
}

/**
 * Pulls each call's own `id`, in request order.
 *
 * Read from OUR validated request, never from whatever the upstream
 * echoes back: an id is how the caller matches an answer to its call, and
 * trusting an id supplied by the very party this function's caller
 * (`forward`) is defending against would let a malformed or adversarial
 * upstream response scramble that matching instead of just failing it.
 */
function requestIds(payload: unknown): JsonRpcId[] {
  const calls = Array.isArray(payload) ? payload : [payload];
  return calls.map((call) => {
    const id = (call as { id?: unknown }).id;
    return typeof id === "string" || typeof id === "number" || id === null ? id : null;
  });
}

/** One request id's answer, once its upstream entry is already known-recognised. */
function safeEntry(id: JsonRpcId, entry: { result?: unknown; error?: unknown }): unknown {
  if ("result" in entry) return { jsonrpc: "2.0", id, result: entry.result };
  return { jsonrpc: "2.0", id, error: GENERIC_UPSTREAM_ERROR };
}

/**
 * Forwards an already-whitelisted payload to the configured Solana endpoint
 * and answers with a response THIS proxy constructs — never one relayed
 * from upstream as it arrived.
 *
 * No upstream response reaches the caller verbatim, whatever its status.
 * Only `result` (on success) or a fixed generic message (on any failure) is
 * ever read out of it and placed into a fresh JSON-RPC envelope carrying
 * our caller's own request id. That is deliberate, not incidental: a paid
 * provider's non-2xx error bodies routinely echo request context —
 * including the very URL, with its embedded key, that this endpoint exists
 * to keep server-side — back at the caller, for auth failures, rate limits
 * and malformed requests alike. A 2xx is not exempt either: nothing stops a
 * provider from putting the same kind of detail into an `error` member of
 * an otherwise well-formed 200. So this treats "parse the bytes into
 * something meaningful" and "decide whether to trust what's inside" as one
 * step, not two — there is no code path that gets from an upstream byte to
 * the response without going through `isJsonRpcResponse` and `safeEntry`
 * first.
 *
 * Only `content-type` is ever sent upstream — no header from the inbound
 * request is forwarded. Forwarding, say, `cookie` or `authorization` would
 * leak them to a third party for no reason this proxy needs; the provider
 * gets exactly the JSON-RPC payload and nothing about who asked.
 *
 * `fetch` failing outright (DNS, TLS, a refused connection) can put the
 * target URL into `error.message` or `error.cause` depending on the
 * runtime, so the caught error there is never read, logged, or
 * interpolated into anything that reaches the response or a log line —
 * the same discipline the content check above applies to a response that
 * did come back.
 */
async function forward(payload: unknown): Promise<{ status: number; body: unknown }> {
  const endpoint = solanaRpcUrls()[0];
  const ids = requestIds(payload);
  const isBatch = Array.isArray(payload);

  let upstream: Response;
  try {
    upstream = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { status: 502, body: failureBody(ids, isBatch) };
  }

  let parsed: unknown;
  try {
    parsed = await upstream.json();
  } catch {
    return { status: 502, body: failureBody(ids, isBatch) };
  }

  // A non-2xx status can itself be meaningful about the provider (which
  // auth failure, which rate limit) beyond just "this call did not
  // succeed" — collapsed to a fixed 502 along with everything else that
  // did not succeed, rather than relayed.
  if (!upstream.ok) {
    return { status: 502, body: failureBody(ids, isBatch) };
  }

  if (isBatch) {
    if (!Array.isArray(parsed) || parsed.length !== ids.length) {
      // A batch answered with the wrong shape is not a batch this proxy
      // can match back to the calls that were sent — every id fails.
      return { status: 502, body: failureBody(ids, isBatch) };
    }
    return {
      status: 200,
      body: ids.map((id, index) => {
        const entry = parsed[index];
        return isJsonRpcResponse(entry)
          ? safeEntry(id, entry)
          : { jsonrpc: "2.0", id, error: GENERIC_UPSTREAM_ERROR };
      }),
    };
  }

  if (!isJsonRpcResponse(parsed)) {
    // Valid JSON, 2xx status, but not a JSON-RPC response — e.g. an
    // unexpected object shape, or the array a batch would have returned.
    // Not something to interpret or pass along; an upstream failure like
    // any other.
    return { status: 502, body: failureBody(ids, isBatch) };
  }

  return { status: 200, body: safeEntry(ids[0], parsed) };
}

export async function POST(request: Request): Promise<Response> {
  const caller = identify(request);
  if (!caller.ok) return json({ error: caller.message }, { status: 400, headers: NO_STORE });

  const cookie: Record<string, string> = caller.setCookie
    ? { "set-cookie": caller.setCookie }
    : {};

  // Rate-limited before the RPC call it exists to protect, never after:
  // there is no quota left to save once the call already happened.
  if (tooManyRpcCalls(caller.ipHash)) {
    return json(
      { error: "Too many RPC requests from this address. Try again shortly." },
      { status: 429, headers: { ...NO_STORE, ...cookie } },
    );
  }

  const capped = await readCappedBody(request, MAX_BODY_BYTES);
  if (!capped.ok) {
    return json(
      { error: `Request body must be at most ${MAX_BODY_BYTES} bytes.` },
      { status: 413, headers: { ...NO_STORE, ...cookie } },
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(capped.text);
  } catch {
    return json({ error: "Body must be JSON." }, { status: 400, headers: { ...NO_STORE, ...cookie } });
  }

  if (!isWhitelistedRequest(payload)) {
    return json(
      { error: "That RPC method is not available through this proxy." },
      { status: 400, headers: { ...NO_STORE, ...cookie } },
    );
  }

  const result = await forward(payload);
  return json(result.body, { status: result.status, headers: { ...NO_STORE, ...cookie } });
}
