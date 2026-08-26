import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Layer 3 of the pre-launch noindex — see `src/app/robots.ts` for the whole
   * story and the launch checklist.
   *
   * This layer exists because the other two cannot see most of this site. A
   * `<meta>` tag needs a `<head>`, and `/api/canvas`, `/api/leaderboard` and
   * every other route handler answer with JSON that has none. A header does
   * not care what the body is, so this is the only one of the three that
   * covers the whole surface.
   *
   * `/:path*` is the documented catch-all and matches `/` too, since `*` allows
   * zero segments. Headers are checked before the filesystem, so this also
   * covers `/public` assets.
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" }],
      },
    ];
  },
};

export default nextConfig;
