import { chromium } from "playwright";

/**
 * How much of the screen is the board, and what takes the rest.
 *
 * Measures the RENDERED boxes, not the CSS that produces them: the question is
 * what a visitor's screen actually spends, and a class name cannot answer that
 * at four viewports.
 *
 * NOT PART OF `npm test`, DELIBERATELY. Playwright is not a dependency of this
 * project and `~/.claude/GATES.md` treats a Playwright run as a machine-wide
 * exclusive resource — putting one inside the suite would make every unrelated
 * run contend for it. The budget this produces is recorded in DESIGN.md §5 and
 * `board-share.test.ts` guards the mechanisms that keep it true; this script is
 * how the numbers are re-derived when the layout changes.
 *
 * HOW TO RUN IT. Start the app against a database that has a LIVE war — the
 * board does not render without one, and production usually has none:
 *
 *   DATABASE_URL="$PREVIEW_DATABASE_URL" PORT=3105 npm start
 *   node scripts/board-share.mjs http://localhost:3105/
 *
 * Playwright resolves from an npx cache rather than node_modules; run it from
 * a directory where `import "playwright"` resolves.
 */

const URL = process.argv[2] ?? "http://localhost:3105/";
const VIEWPORTS = [
  { name: "390x844", width: 390, height: 844, dsf: 3 },
  { name: "1440x900", width: 1440, height: 900, dsf: 2 },
  { name: "1920x1080", width: 1920, height: 1080, dsf: 1 },
  { name: "2560x1440", width: 2560, height: 1440, dsf: 1 },
];

const browser = await chromium.launch();
const rows = [];

for (const vp of VIEWPORTS) {
  const page = await browser.newPage({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.dsf,
  });
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  // networkidle never fires: the board polls every two seconds, so there is
  // always a request in flight. Wait for the thing being measured instead.
  await page.waitForFunction(() => {
    const c = document.querySelector("canvas");
    return c && c.getBoundingClientRect().width > 0;
  }, null, { timeout: 30000 });
  // The board sizes itself from its container via a ResizeObserver and the
  // first poll fills in the pixels, so a measurement taken at first paint is
  // of a canvas that has not settled.
  await page.waitForTimeout(2500);

  const m = await page.evaluate(() => {
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      return { w: Math.round(r.width), h: Math.round(r.height), area: Math.round(r.width * r.height) };
    };
    const vis = (el) => el && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().width > 0;

    const canvas = document.querySelector("canvas");
    const header = document.querySelector("header");
    const aside = document.querySelector("aside");
    const frame = document.querySelector(".board-frame");
    // The paint bar is the shrink-0 stack under the board frame.
    const paintBar = frame?.parentElement?.querySelector(":scope > div:last-child");

    return {
      viewport: { w: window.innerWidth, h: window.innerHeight, area: window.innerWidth * window.innerHeight },
      canvas: box(canvas),
      header: box(header),
      rail: vis(aside) ? box(aside) : null,
      frame: box(frame),
      paintBar: box(paintBar),
      railIsSheet: aside ? getComputedStyle(aside).position === "absolute" : null,
    };
  });

  const pct = (a) => (a === null ? null : +((a / m.viewport.area) * 100).toFixed(1));
  rows.push({
    viewport: vp.name,
    "board %": pct(m.canvas?.area ?? null),
    "board px": m.canvas ? `${m.canvas.w}x${m.canvas.h}` : "—",
    "header %": pct(m.header?.area ?? null),
    "rail %": pct(m.rail?.area ?? null),
    "paintbar %": pct(m.paintBar?.area ?? null),
    "frame %": pct(m.frame?.area ?? null),
    sheet: m.railIsSheet,
  });

  await page.close();
}

await browser.close();
console.table(rows);
console.log("\nboard % = <canvas> box area / viewport area. rail null = not rendered at that width.");
