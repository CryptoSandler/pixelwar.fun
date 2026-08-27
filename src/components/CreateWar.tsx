"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Opens a war.
 *
 * WHO CALLS `POST /api/admin/wars/create`: this form.
 *
 * Until it existed, a war could only come into being through
 * `scripts/seed-war.mts` — running an event required a developer at a
 * terminal, which is the difference between a product and a demo. The script
 * stays as a development tool; it is no longer the only door.
 */
export function CreateWar() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [form, setForm] = useState({
    slug: "",
    title: "",
    entryPriceUsd: "25",
    cooldownSeconds: "30",
    maxTokens: "24",
    startsAt: "",
    endsAt: "",
  });

  const set = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  if (!open) {
    return (
      <button type="button" className="btn-primary self-start px-4 py-2" onClick={() => setOpen(true)}>
        Open a war
      </button>
    );
  }

  return (
    <form
      className="panel bevel flex flex-col gap-2 p-3"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setMessage(null);
        try {
          const response = await fetch("/api/admin/wars/create", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              slug: form.slug,
              title: form.title,
              entryPriceUsd: Number(form.entryPriceUsd),
              cooldownSeconds: Number(form.cooldownSeconds),
              maxTokens: Number(form.maxTokens),
              startsAt: new Date(form.startsAt).toISOString(),
              endsAt: new Date(form.endsAt).toISOString(),
            }),
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) {
            setMessage(typeof body?.error === "string" ? body.error : "That did not work.");
            return;
          }
          // Scheduled, never live — advanceWar owns the transition.
          setMessage(`Opened ${body.slug}, ${body.status}.`);
          setOpen(false);
          router.refresh();
        } catch {
          setMessage("That request did not come back.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3 className="text-[15px] font-medium">Open a war</h3>

      <label className="flex flex-col text-[12px]">
        Slug (lowercase, hyphens — it is the URL and it is forever)
        <input className="field px-2 py-1" required value={form.slug} onChange={set("slug")} />
      </label>
      <label className="flex flex-col text-[12px]">
        Title
        <input className="field px-2 py-1" required value={form.title} onChange={set("title")} />
      </label>

      <div className="flex flex-wrap gap-2">
        <label className="flex flex-col text-[12px]">
          Entry price (USD)
          <input className="field numeric w-24 px-2 py-1" type="number" min={1} step={1} required value={form.entryPriceUsd} onChange={set("entryPriceUsd")} />
        </label>
        <label className="flex flex-col text-[12px]">
          Cooldown (seconds)
          <input className="field numeric w-24 px-2 py-1" type="number" min={1} max={3600} step={1} required value={form.cooldownSeconds} onChange={set("cooldownSeconds")} />
        </label>
        <label className="flex flex-col text-[12px]">
          Admission cap
          <input className="field numeric w-24 px-2 py-1" type="number" min={1} max={255} step={1} required value={form.maxTokens} onChange={set("maxTokens")} />
        </label>
      </div>

      <div className="flex flex-wrap gap-2">
        <label className="flex flex-col text-[12px]">
          Opens
          <input className="field px-2 py-1" type="datetime-local" required value={form.startsAt} onChange={set("startsAt")} />
        </label>
        <label className="flex flex-col text-[12px]">
          Closes
          <input className="field px-2 py-1" type="datetime-local" required value={form.endsAt} onChange={set("endsAt")} />
        </label>
      </div>

      {/* Said where the number is typed, not only in docs/operations.md: past
          24 two tokens fly the same flag and the territory view stops
          answering the question it exists for. */}
      <p className="muted text-[12px]">
        Keep the cap at 24 or fewer until the palette has more than 24 colours.
      </p>

      <div className="flex items-center gap-3">
        <button type="submit" className="btn-primary px-3 py-1.5" disabled={busy}>
          {busy ? "Opening" : "Open"}
        </button>
        <button type="button" className="btn-secondary bevel px-3 py-1.5" onClick={() => setOpen(false)}>
          Cancel
        </button>
        {message ? <span className="text-[12px]">{message}</span> : null}
      </div>
    </form>
  );
}
