import { writeFileSync } from "node:fs";
import { boardSvg, TOKENS, PALETTE, GROUND } from "./board.mjs";
const svg = boardSvg(3);
const swatch = (s) => PALETTE[s - 1];

const rows = (opts) => TOKENS.map((t, i) => `
  <li class="row ${i === 0 ? "lead" : ""} ${i === 2 ? "mine" : ""}">
    <span class="chip" style="background:${swatch(t.slot)}"></span>
    <span class="tk">${t.ticker}</span>
    <span class="ct">${t.owned.toLocaleString("en-US")}</span>
    <span class="bar"><i style="width:${(t.owned / 4182) * 100}%;background:${swatch(t.slot)}"></i></span>
    ${opts.key ? `<kbd>${i + 1}</kbd>` : ""}
  </li>`).join("");

const paintbar = (opts) => TOKENS.map((t, i) => `
  <button class="sw ${i === 2 ? "on" : ""}" style="--c:${swatch(t.slot)}">
    <span style="background:${swatch(t.slot)}"></span><b>${t.ticker}</b>
  </button>`).join("");

const page = ({ id, name, base, css, header, footerNote }) => `<!doctype html><meta charset="utf-8">
<title>${name}</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Jost:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{width:1440px;height:900px;overflow:hidden;display:flex;flex-direction:column}
.board{image-rendering:pixelated}
.rail{display:flex;flex-direction:column}
ul{list-style:none}
kbd{font:inherit;opacity:.35}
${css}
</style>
<body>
${header}
<main>
  <aside class="rail">
    <h2>Leaderboard</h2>
    <ul>${rows({ key: id === "a" })}</ul>
    <p class="note">${footerNote}</p>
  </aside>
  <section class="stage">
    <div class="hud"><span>(134, 86) 3.0x</span><span>41:13:37 left</span></div>
    <div class="frame">${svg}</div>
    <div class="paintbar">
      <div class="sws">${paintbar({})}</div>
      <button class="paint">Paint</button>
    </div>
  </section>
</main>
</body>`;

/* ---------- A — Instrument (base: linear.app, MIT) ---------- */
const A = page({ id: "a", name: "A — Instrument",
  footerNote: "Pixels held right now. Overpainting moves them.",
  header: `<header><b>pixelwar.fun</b><span class="live">● live</span><span class="war">Demo war</span></header>`,
  css: `
body{background:#010102;color:#f7f8f8;font-family:system-ui,-apple-system,sans-serif;letter-spacing:-.011em}
header{height:52px;display:flex;align-items:center;gap:16px;padding:0 20px;border-bottom:1px solid #23252a;font-size:13px;letter-spacing:.01em}
header b{font-weight:600} .live{color:#8a8f98;font-size:11px} .war{margin-left:auto;color:#8a8f98;font-size:12px}
main{flex:1;display:flex}
.rail{width:264px;border-right:1px solid #23252a;padding:18px 16px;gap:14px}
h2{font-size:11px;text-transform:uppercase;letter-spacing:.09em;color:#62666d;font-weight:500}
.row{display:grid;grid-template-columns:10px 1fr auto 56px 14px;gap:9px;align-items:center;padding:7px 0;font-size:13px}
.chip{width:10px;height:10px}
.tk{font-weight:500}
.ct{font-family:"SF Mono",Menlo,monospace;font-variant-numeric:tabular-nums;color:#8a8f98;font-size:11px}
.bar{height:2px;background:#23252a}.bar i{display:block;height:2px}
.row.mine .tk{color:#fff}
.note{margin-top:auto;font-size:11px;color:#62666d;line-height:1.5}
.stage{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px}
.hud{width:600px;display:flex;justify-content:space-between;font-family:Menlo,monospace;font-size:11px;color:#62666d}
.frame{border:1px solid #23252a;line-height:0}
.paintbar{width:600px;display:flex;align-items:center;gap:12px}
.sws{display:flex;gap:4px;flex:1}
.sw{background:none;border:1px solid #23252a;border-radius:2px;padding:5px 7px;display:flex;align-items:center;gap:5px;color:#8a8f98;font-size:11px;cursor:pointer}
.sw span{width:8px;height:8px;display:block}
.sw.on{border-color:#B4AFFA;color:#f7f8f8}
.paint{border:0;border-radius:2px;padding:9px 22px;font-size:13px;font-weight:600;color:#12131a;background:#B4AFFA;cursor:pointer}
` });

/* ---------- B — Workshop (base: miro, MIT) ---------- */
const B = page({ id: "b", name: "B — Workshop",
  footerNote: "Pixels held right now — not pixels placed. Defending counts.",
  header: `<header><b>pixelwar<i>.fun</i></b><span class="war">Demo war · 6 tokens</span></header>`,
  css: `
body{background:#FBFAF7;color:#1c1c1e;font-family:"Avenir Next","Avenir",system-ui,sans-serif}
header{height:60px;display:flex;align-items:center;gap:14px;padding:0 26px;border-bottom:1px solid #E7E3DA}
header b{font-size:18px;font-weight:600;border-bottom:3px solid #A5876E;padding-bottom:1px}
header b i{font-style:normal;color:#8B857A}
.war{margin-left:auto;font-size:13px;color:#6F6A61}
main{flex:1;display:flex;padding:26px;gap:26px}
.rail{width:288px;gap:16px}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#8B857A;font-weight:600}
.row{display:grid;grid-template-columns:14px 1fr auto 64px;gap:11px;align-items:center;padding:10px 0;border-bottom:1px solid #F0EDE6;font-size:14px}
.chip{width:14px;height:14px}
.tk{font-weight:600}
.ct{font-variant-numeric:tabular-nums;color:#6F6A61;font-size:13px}
.bar{height:6px;background:#F0EDE6;border-radius:3px;overflow:hidden}.bar i{display:block;height:6px}
.row.lead{background:#F5F0E8;margin:0 -10px;padding:10px;border-radius:10px}
.note{margin-top:auto;font-size:12px;color:#8B857A;line-height:1.55}
.stage{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px}
.hud{width:600px;display:flex;justify-content:space-between;font-family:Menlo,monospace;font-size:12px;color:#8B857A}
.frame{line-height:0;border:1px solid #E7E3DA;border-radius:10px;overflow:hidden;box-shadow:0 8px 28px rgba(28,28,30,.10)}
.paintbar{width:600px;display:flex;align-items:center;gap:14px}
.sws{display:flex;gap:6px;flex:1}
.sw{background:#fff;border:1px solid #E7E3DA;border-radius:10px;padding:7px 9px;display:flex;align-items:center;gap:6px;font-size:12px;color:#6F6A61;cursor:pointer}
.sw span{width:11px;height:11px;display:block}
.sw.on{border-color:#A5876E;box-shadow:0 0 0 2px #A5876E33;color:#1c1c1e;font-weight:600}
.paint{border:0;border-radius:10px;padding:11px 26px;font-size:14px;font-weight:600;color:#1c1c1e;background:#A5876E;cursor:pointer}
` });

/* ---------- C — Cabinet (base: nintendo-2001, MIT) ---------- */
const C = page({ id: "c", name: "C — Cabinet",
  footerNote: "PIXELS HELD · LIVE COUNT",
  header: `<header><b>PIXELWAR.FUN</b><span class="war">DEMO WAR</span></header>`,
  css: `
body{background:#A8B1C6;color:#21242e;font-family:"Jost",sans-serif}
header{height:46px;display:flex;align-items:center;gap:14px;padding:0 18px;background:#21242e;color:#fff}
header b{font-size:16px;font-weight:500;letter-spacing:.14em;color:#B1923B}
.war{margin-left:auto;font-family:"IBM Plex Mono",monospace;font-size:11px;letter-spacing:.14em;color:#9fbee7}
main{flex:1;display:flex;padding:20px;gap:20px}
.rail{width:280px;background:#dedede;border:2px solid #fff;border-right-color:#3d4f97;border-bottom-color:#3d4f97;padding:14px;gap:12px}
h2{font-family:"IBM Plex Mono",monospace;font-size:11px;letter-spacing:.14em;color:#3d4f97;font-weight:600}
.row{display:grid;grid-template-columns:12px 1fr auto 58px;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid #c6c6c6;font-size:13px}
.chip{width:12px;height:12px;outline:1px solid #21242e}
.tk{font-weight:500;letter-spacing:.06em}
.ct{font-family:"IBM Plex Mono",monospace;font-size:12px;color:#3d4f97}
.bar{height:8px;background:#fff;outline:1px solid #b9b9b9}.bar i{display:block;height:8px}
.note{margin-top:auto;font-family:"IBM Plex Mono",monospace;font-size:10px;letter-spacing:.12em;color:#60619c}
.stage{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px}
.hud{width:604px;display:flex;justify-content:space-between;font-family:"IBM Plex Mono",monospace;font-size:11px;color:#21242e;background:#AEC0DE;padding:4px 8px;border:1px solid #3d4f97}
.frame{line-height:0;border:3px solid #21242e;box-shadow:inset 0 0 0 2px #60619c}
.paintbar{width:604px;display:flex;align-items:center;gap:12px}
.sws{display:flex;gap:4px;flex:1}
.sw{background:#dedede;border:2px solid #fff;border-right-color:#8b8b8b;border-bottom-color:#8b8b8b;padding:5px 8px;display:flex;align-items:center;gap:5px;font-size:11px;font-weight:700;cursor:pointer}
.sw span{width:10px;height:10px;display:block;outline:1px solid #21242e}
.sw.on{border-color:#B1923B;background:#fff}
.paint{border:2px solid #fff;border-right-color:#7A6420;border-bottom-color:#7A6420;background:#B1923B;color:#fff;padding:9px 24px;font-size:13px;font-weight:800;letter-spacing:.05em;cursor:pointer}
` });

writeFileSync(`${import.meta.dirname}/a-instrument.html`, A);
writeFileSync(`${import.meta.dirname}/b-workshop.html`, B);
writeFileSync(`${import.meta.dirname}/c-cabinet.html`, C);
console.log("three mockups written");
