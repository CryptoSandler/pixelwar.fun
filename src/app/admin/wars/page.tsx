import Link from "next/link";
import { AdmissionCap } from "../../../components/AdmissionCap";
import { CreateWar } from "../../../components/CreateWar";
import { WarClocks } from "../../../components/WarClocks";
import { Moderation, type BanRow } from "../../../components/Moderation";
import { Cabinet } from "../../../components/Cabinet";
import { adminSessionLabel } from "../../../lib/admin";
import { query } from "../../../lib/db";
import { listBans } from "../../../lib/moderation";

export const dynamic = "force-dynamic";

type WarRow = {
  id: string;
  title: string;
  slug: string;
  status: string;
  max_tokens: number;
  width: number;
  height: number;
  starts_at: Date;
  ends_at: Date;
  seated: string;
};

/**
 * Every war and how many communities it will seat.
 *
 * WHO CALLS `POST /api/admin/wars/[id]/cap`: the `AdmissionCap` control this
 * page renders, one per war. Stated because AGENTS.md asks it of every new
 * route, and because a batch here once shipped two finished functions that
 * nothing called.
 *
 * A server component reading the rows directly, like `/admin/orphans`: the
 * screen is correct on first paint instead of empty for a round trip. Only
 * the control that WRITES is a client component.
 *
 * FAILS CLOSED the same way the rest of the surface does — no session, no
 * page. `adminSessionLabel` returns null when the deployment has no
 * ADMIN_TOKEN at all, so an unconfigured deployment has no admin screens
 * rather than open ones.
 */
export default async function AdminWarsPage() {
  const label = await adminSessionLabel();
  if (!label) {
    return (
      <Cabinet label="Admin">
        <section className="panel bevel flex flex-col gap-3 p-4">
          <h1 className="text-[20px] font-medium">Not signed in</h1>
          <Link href="/admin" className="btn-primary self-start px-4 py-2">
            Sign in
          </Link>
        </section>
      </Cabinet>
    );
  }

  // Read here rather than fetched by the panel: the screen is correct on
  // first paint instead of empty for a round trip, the same way
  // /admin/orphans reads its own rows. Only the controls that WRITE are
  // client components.
  const bans = await listBans();
  const banRows: BanRow[] = bans.map((ban) => ({
    id: ban.id,
    keyType: ban.keyType,
    key: ban.key,
    reason: ban.reason,
    actor: ban.actor,
    live: ban.live,
    createdAt: ban.createdAt.toISOString(),
    expiresAt: ban.expiresAt?.toISOString() ?? null,
  }));

  const wars = await query<WarRow>(
    `SELECT w.id, w.title, w.slug, w.status, w.max_tokens, w.width, w.height, w.starts_at, w.ends_at,
            (SELECT count(*) FROM war_tokens t
              WHERE t.war_id = w.id AND t.status IN ('reserved','active')) AS seated
       FROM wars w
      ORDER BY w.starts_at DESC`,
  );

  return (
    <Cabinet label="Admin">
      <section className="flex flex-col gap-3">
        <h1 className="text-[20px] font-medium">Wars</h1>
        <p className="muted text-[13px]">
          The admission cap is how many communities a war will seat. It used to be pinned at 24
          because that was the size of the palette, back when a token was a colour. It is a
          judgement now.
        </p>
        {/* An operating rule, not a constraint — see docs/operations.md for why
            this is not a CHECK. Said here because this is where somebody is
            about to type the number. */}
        <p className="text-[13px]">
          Keep wars at <span className="numeric">24</span> or fewer until the palette has more
          than 24 colours. Above that, two tokens fly the same flag and the territory view stops
          answering the question it exists for.
        </p>

        <CreateWar />

        {wars.length === 0 ? (
          <p className="muted text-[13px]">No wars yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {wars.map((war) => (
              <li key={war.id} className="flex flex-col gap-3">
                <AdmissionCap
                  warId={war.id}
                  title={`${war.title} (${war.status})`}
                  current={war.max_tokens}
                  seated={Number(war.seated)}
                />
                <WarClocks
                  warId={war.id}
                  status={war.status}
                  startsAt={war.starts_at.toISOString()}
                  endsAt={war.ends_at.toISOString()}
                />
                <Moderation
                  warId={war.id}
                  warSlug={war.slug}
                  warStatus={war.status}
                  width={war.width}
                  height={war.height}
                  bans={banRows}
                />
              </li>
            ))}
          </ul>
        )}

        <Link href="/admin" className="btn-secondary self-start px-3 py-2">
          Back
        </Link>
      </section>
    </Cabinet>
  );
}
