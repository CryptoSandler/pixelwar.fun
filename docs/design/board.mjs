// One shared board so the three directions differ only in chrome, never in content.
export const PALETTE = ["#BE0039","#FF4500","#FFA800","#FFD635","#FFF8B8","#00A368","#00CC78","#7EED56","#00756F","#009EAA","#00CCC0","#2450A4","#3690EA","#51E9F4","#493AC1","#6A5CFF","#811E9F","#B44AC0","#FF3881","#FF99AA","#6D482F","#FFB470","#000000","#FFFFFF"];
export const GROUND = "#2E2E38";
export const TOKENS = [
  { ticker: "PEPE",   slot: 6,  owned: 4182 },
  { ticker: "WIF",    slot: 13, owned: 3907 },
  { ticker: "BONK",   slot: 3,  owned: 2440 },
  { ticker: "MOG",    slot: 18, owned: 1876 },
  { ticker: "POPCAT", slot: 2,  owned: 1355 },
  { ticker: "GIGA",   slot: 24, owned: 902  },
];
// Deterministic pseudo-art: blobs per token, so every mockup shows the same war.
export function board(w = 200, h = 200) {
  const px = new Uint8Array(w * h);
  let seed = 20260825;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (const [i, t] of TOKENS.entries()) {
    const cx = 30 + ((i * 37) % 140), cy = 26 + ((i * 61) % 140);
    const r = 34 - i * 3;
    for (let n = 0; n < r * r * 2.4; n++) {
      const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * r;
      const x = Math.round(cx + Math.cos(a) * d), y = Math.round(cy + Math.sin(a) * d * 0.8);
      if (x >= 0 && y >= 0 && x < w && y < h) px[y * w + x] = t.slot;
    }
  }
  for (let n = 0; n < 900; n++) {           // scattered lone pixels: a real board is never tidy
    const x = Math.floor(rnd() * w), y = Math.floor(rnd() * h);
    px[y * w + x] = TOKENS[Math.floor(rnd() * TOKENS.length)].slot;
  }
  return { px, w, h };
}
export function boardSvg(scale = 3) {
  const { px, w, h } = board();
  const runs = [];
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      const v = px[y * w + x]; let n = 1;
      while (x + n < w && px[y * w + x + n] === v) n++;
      if (v !== 0) runs.push(`<rect x="${x}" y="${y}" width="${n}" height="1" fill="${PALETTE[v - 1]}"/>`);
      x += n;
    }
  }
  return `<svg viewBox="0 0 ${w} ${h}" width="${w * scale}" height="${h * scale}" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg"><rect width="${w}" height="${h}" fill="${GROUND}"/>${runs.join("")}</svg>`;
}
