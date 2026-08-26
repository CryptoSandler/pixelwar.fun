import { requireAdmin } from "../../../../../../lib/admin-guard";
import { execute, queryOne } from "../../../../../../lib/db";
import { json, NO_STORE } from "../../../../../../lib/http";
import { MAX_TOKEN_SLOT } from "../../../../../../lib/wars/palette";

export const dynamic = "force-dynamic";

/**
 * Sets one war's admission cap.
 *
 * WHO CALLS THIS: the form on `/admin/wars`, which posts here and is
 * redirected back. Named explicitly because AGENTS.md asks, and because the
 * last batch shipped two finished, reviewed functions that nothing called.
 *
 * WHY THIS EXISTS AT ALL. `wars.max_tokens` used to be pinned at 24 by a
 * CHECK constraint, and 24 was not a decision — it was the size of the
 * palette, back when a token WAS a colour. Migration 007 removed that
 * premise and migration 008 removed the constraint, which left the cap as
 * what it should always have been: how many communities an operator is
 * willing to seat in one war. That is a judgement, it differs per war, and a
 * judgement that needs a migration to change is not a setting.
 *
 * LOWERING IT NEVER EVICTS ANYBODY. The cap is read when a token tries to
 * take a seat (`createOrder`, `settlePayment`); it is not re-checked against
 * tokens already seated. So setting it below the current count closes the
 * door without touching the people already inside — which is the only
 * behaviour that is safe, since the alternative is un-seating a community
 * that has paid.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const admin = await requireAdmin(request, "admin/wars/cap");
  if (!admin.ok) return admin.response;

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body must be JSON" }, { status: 400, headers: NO_STORE });
  }

  const { maxTokens } = (body ?? {}) as Record<string, unknown>;

  // The ceiling is arithmetic, not taste: the territory layer names a pixel's
  // owner in one byte and reserves 0 for unpainted, so a war cannot seat more
  // tokens than that byte can address. Checked here AND by the constraint
  // migration 008 added — this one so the operator gets a sentence, that one
  // so nothing else can get around it.
  if (
    typeof maxTokens !== "number" ||
    !Number.isInteger(maxTokens) ||
    maxTokens < 1 ||
    maxTokens > MAX_TOKEN_SLOT
  ) {
    return json(
      { error: `maxTokens must be a whole number between 1 and ${MAX_TOKEN_SLOT}.` },
      { status: 400, headers: NO_STORE },
    );
  }

  const seated = await queryOne<{ count: string }>(
    `SELECT count(*) AS count FROM war_tokens
      WHERE war_id = $1 AND status IN ('reserved','active')`,
    [id],
  );

  const updated = await execute(`UPDATE wars SET max_tokens = $2 WHERE id = $1`, [id, maxTokens]);
  if (updated === 0) return json({ error: "No such war." }, { status: 404, headers: NO_STORE });

  return json(
    {
      maxTokens,
      // Reported rather than refused. An operator lowering the cap below the
      // seated count is usually doing it on purpose — closing a war down — and
      // the honest thing is to tell them what it means, not to argue.
      seated: Number(seated?.count ?? 0),
    },
    { headers: NO_STORE },
  );
}
