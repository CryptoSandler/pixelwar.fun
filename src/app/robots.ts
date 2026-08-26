import type { MetadataRoute } from "next";

/**
 * robots.txt — the whole site, closed.
 *
 * pixelwar.fun is not launched. Until it is, every deployment (production
 * included) should be reachable by a person with the URL and invisible to a
 * search index, because a half-built canvas indexed under the project's own
 * name is a first impression nobody chose.
 *
 * This is one of THREE independent mechanisms, deliberately, because they fail
 * in different places and no single one of them covers a crawler's whole path:
 *
 *   1. this file            → /robots.txt, `Disallow: /`. Asks a well-behaved
 *                             crawler not to FETCH. It is a request, not a
 *                             control, and it says nothing about a URL someone
 *                             else links to.
 *   2. `metadata.robots`    → `<meta name="robots" content="noindex,nofollow">`
 *                             in every HTML document. Tells a crawler that DID
 *                             fetch not to index. Only reaches HTML — an API
 *                             response has no <head>.
 *   3. `X-Robots-Tag`       → the same instruction as a response header, set in
 *                             `next.config.ts` for every path. This is the one
 *                             that covers `/api/*` and any non-HTML response,
 *                             which neither of the other two can.
 *
 * Note that 1 and 2 pull against each other on purpose: a crawler that obeys
 * robots.txt never fetches the page, so it never sees the noindex — which is
 * why a URL blocked ONLY by robots.txt can still show up in results as a bare
 * link. Layers 2 and 3 are what make the answer "do not index" rather than
 * "do not look", and they only work on requests robots.txt did not stop.
 *
 * TO LAUNCH: change `disallow` to `allow` here, drop the `robots` block from
 * `metadata` in `layout.tsx`, and drop the `X-Robots-Tag` entry from
 * `next.config.ts`. All three, or the site stays invisible while looking open.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      disallow: "/",
    },
  };
}
