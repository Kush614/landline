import type { Palette } from "./types.js";

/**
 * The hero visual for the split layout.
 *
 * We can't source real photography for an arbitrary business, and a stock image
 * would be worse than nothing. So: an abstract geometric composition built from the
 * page's own palette, deterministic per brand so a given business always gets the
 * same one, and inline SVG so it costs no extra request and renders identically in
 * a screenshot.
 *
 * Decorative — marked aria-hidden, never load-bearing for meaning.
 */

/** Stable small hash so the same brand always gets the same motif. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

const W = 480;
const H = 380;

type Motif = (p: Palette, id: string) => string;

/** Concentric arcs sweeping out of one corner — calm, works for services and crafts. */
const arcs: Motif = (p, id) => {
  const rings = [0.95, 0.76, 0.57, 0.38, 0.19]
    .map((k, i) => {
      const r = W * k;
      const op = 0.07 + i * 0.055;
      return `<circle cx="${W * 0.06}" cy="${H * 1.02}" r="${r.toFixed(1)}" fill="none"
        stroke="${p.accent}" stroke-opacity="${op.toFixed(3)}" stroke-width="${(1.6 + i * 0.5).toFixed(1)}"/>`;
    })
    .join("");
  return `${rings}
    <circle cx="${W * 0.72}" cy="${H * 0.26}" r="30" fill="${p.accent}" fill-opacity="0.9"/>
    <circle cx="${W * 0.72}" cy="${H * 0.26}" r="52" fill="none" stroke="${p.accent}" stroke-opacity="0.28" stroke-width="1.5"/>`;
};

/** Offset stacked cards — reads as "collection", good for shops and subscriptions. */
const stack: Motif = (p) => {
  const cards = [
    { x: 96, y: 58, w: 250, h: 168, op: 0.16 },
    { x: 76, y: 84, w: 250, h: 168, op: 0.34 },
    { x: 56, y: 110, w: 250, h: 168, op: 1 },
  ];
  return cards
    .map(
      (c, i) => `<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="16"
        fill="${i === 2 ? p.surface : p.accent}" fill-opacity="${c.op}"
        stroke="${i === 2 ? p.accent : "none"}" stroke-opacity="0.5" stroke-width="1.5"/>`,
    )
    .join("")
    .concat(
      `<rect x="80" y="136" width="104" height="9" rx="4.5" fill="${p.accent}" fill-opacity="0.85"/>
       <rect x="80" y="158" width="158" height="7" rx="3.5" fill="${p.fg}" fill-opacity="0.18"/>
       <rect x="80" y="175" width="128" height="7" rx="3.5" fill="${p.fg}" fill-opacity="0.13"/>
       <rect x="80" y="204" width="72" height="26" rx="8" fill="${p.accent}" fill-opacity="0.92"/>`,
    );
};

/**
 * Measured dot grid with one solid block — quiet and technical. The grid clears a
 * margin around the block so the two read as one composition rather than two
 * unrelated things floating in a box.
 */
const field: Motif = (p) => {
  const bx = 78;
  const by = 96;
  const bw = 190;
  const bh = 128;
  const dots: string[] = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 10; c++) {
      const x = 60 + c * 38;
      const y = 58 + r * 38;
      // Leave breathing room around the block instead of fading dots underneath it.
      if (x > bx - 22 && x < bx + bw + 22 && y > by - 22 && y < by + bh + 22) continue;
      dots.push(`<circle cx="${x}" cy="${y}" r="2.4" fill="${p.fg}" fill-opacity="0.14"/>`);
    }
  }
  return `${dots.join("")}
    <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="14" fill="${p.accent}" fill-opacity="0.1"/>
    <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="14" fill="none" stroke="${p.accent}" stroke-opacity="0.6" stroke-width="1.5"/>
    <rect x="${bx + 24}" y="${by + 30}" width="84" height="8" rx="4" fill="${p.accent}" fill-opacity="0.75"/>
    <rect x="${bx + 24}" y="${by + 52}" width="128" height="7" rx="3.5" fill="${p.fg}" fill-opacity="0.16"/>
    <rect x="${bx + 24}" y="${by + 69}" width="102" height="7" rx="3.5" fill="${p.fg}" fill-opacity="0.12"/>
    <circle cx="${bx + bw + 74}" cy="${by + bh - 6}" r="38" fill="${p.accent}" fill-opacity="0.9"/>
    <path d="M ${bx} ${by + bh + 54} H ${bx + bw + 112}" stroke="${p.fg}" stroke-opacity="0.14" stroke-width="1.5"/>`;
};

/**
 * Two circles with their intersection picked out as a solid lens. Reads as craft
 * and overlap rather than as a Venn diagram, because the accent lands only on the
 * shared sliver instead of flooding a whole disc.
 */
const overlap: Motif = (p) => {
  const c1 = { x: W * 0.4, y: H * 0.46, r: 112 };
  const c2 = { x: W * 0.63, y: H * 0.56, r: 88 };

  const dx = c2.x - c1.x;
  const dy = c2.y - c1.y;
  const d = Math.hypot(dx, dy);
  // Standard two-circle intersection: project onto the centre line, then step off it.
  const a = (c1.r * c1.r - c2.r * c2.r + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, c1.r * c1.r - a * a));
  const mx = c1.x + (a * dx) / d;
  const my = c1.y + (a * dy) / d;
  const p1 = { x: mx + (h * -dy) / d, y: my + (h * dx) / d };
  const p2 = { x: mx - (h * -dy) / d, y: my - (h * dx) / d };
  const lens =
    `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} ` +
    `A ${c1.r} ${c1.r} 0 0 1 ${p2.x.toFixed(1)} ${p2.y.toFixed(1)} ` +
    `A ${c2.r} ${c2.r} 0 0 1 ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} Z`;

  return `
  <circle cx="${c1.x}" cy="${c1.y}" r="${c1.r}" fill="${p.accent}" fill-opacity="0.13"/>
  <circle cx="${c1.x}" cy="${c1.y}" r="${c1.r}" fill="none" stroke="${p.accent}" stroke-opacity="0.55" stroke-width="1.5"/>
  <circle cx="${c2.x}" cy="${c2.y}" r="${c2.r}" fill="${p.fg}" fill-opacity="0.06"/>
  <circle cx="${c2.x}" cy="${c2.y}" r="${c2.r}" fill="none" stroke="${p.accent}" stroke-opacity="0.32" stroke-width="1.5"/>
  <path d="${lens}" fill="${p.accent}" fill-opacity="0.92"/>
  <path d="M ${W * 0.16} ${H * 0.86} H ${W * 0.84}" stroke="${p.fg}" stroke-opacity="0.14" stroke-width="1.5"/>
  <circle cx="${W * 0.84}" cy="${H * 0.86}" r="4.5" fill="${p.accent}" fill-opacity="0.85"/>`;
};

const MOTIFS: Motif[] = [stack, arcs, field, overlap];

/**
 * Nudges the choice toward something that suits the business, then falls back to
 * the brand hash so two coffee shops don't get identical pages.
 */
function pick(brief: string, brand: string): Motif {
  const b = brief.toLowerCase();
  if (/\b(shop|store|sell|product|subscription|bag|merch|pricing|plan)\b/.test(b)) return stack;
  if (/\b(software|saas|api|data|engineer|technical|dev|platform|analytics|studio)\b/.test(b)) return field;
  if (/\b(coffee|bakery|food|cafe|restaurant|salon|grooming|yoga|candle|craft)\b/.test(b)) return overlap;
  return MOTIFS[hash(brand) % MOTIFS.length];
}

export function heroMotif(palette: Palette, brand: string, brief: string): string {
  const id = `m${(hash(brand) % 9973).toString(36)}`;
  const motif = pick(brief, brand);
  return `<svg class="motif" viewBox="0 0 ${W} ${H}" role="presentation" aria-hidden="true" preserveAspectRatio="xMidYMid slice">
  <defs>
    <linearGradient id="${id}g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${palette.accent}" stop-opacity="0.14"/>
      <stop offset="55%" stop-color="${palette.surface}" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="${id}c"><rect x="0" y="0" width="${W}" height="${H}" rx="18"/></clipPath>
  </defs>
  <g clip-path="url(#${id}c)">
    <rect x="0" y="0" width="${W}" height="${H}" fill="${palette.surface}"/>
    <rect x="0" y="0" width="${W}" height="${H}" fill="url(#${id}g)"/>
    ${motif(palette, id)}
  </g>
  <rect x="0.75" y="0.75" width="${W - 1.5}" height="${H - 1.5}" rx="17.25" fill="none" stroke="${palette.border}" stroke-width="1.5"/>
</svg>`;
}
