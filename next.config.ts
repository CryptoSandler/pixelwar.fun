import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * The share card's two typefaces, forced into the deployed function.
   *
   * `app/og/[slug]/route.tsx` reads them with `readFile` from a path built at
   * runtime out of `process.cwd()`. Next's tracer follows literal requires and
   * static imports; it does not follow a path assembled from `join`, so
   * without this entry the fonts exist in the repository, exist in every local
   * run, and are ABSENT from the deployment — where the route throws ENOENT on
   * its first request and the card 500s. That failure cannot be reproduced by
   * any amount of local testing, which is the whole reason this is written
   * down rather than discovered.
   *
   * A relative `readFile` would not fix it; the tracer's problem is that it
   * cannot see the string, not where the string points.
   */
  outputFileTracingIncludes: {
    "/og/[slug]": ["./src/app/og/fonts/*.ttf"],
  },

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
