"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Sign out of the admin surface.
 *
 * WHO CALLS `DELETE /api/admin/session`: this button, and nothing else. The
 * endpoint revokes the session row server-side, which is the part that holds
 * even if the browser ignores the cookie it is handed back — so signing out
 * has to be a request, and a plain HTML form cannot send DELETE. That is the
 * whole reason this one control is a client component while the rest of
 * `/admin` is not.
 *
 * `router.refresh()` afterwards, not a bare state flip: the cookie is gone and
 * the sign-in form is rendered by a SERVER component, so the only way to see
 * the true post-sign-out screen is to ask the server again.
 */
export function AdminSignOut() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <button
      type="button"
      className="btn-secondary px-3 py-2"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await fetch("/api/admin/session", { method: "DELETE" });
        } finally {
          router.push("/admin");
          router.refresh();
        }
      }}
    >
      {busy ? "Signing out" : "Sign out"}
    </button>
  );
}
