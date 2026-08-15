import type { VariantSpec } from "./types.js";
import { FONTS } from "./palettes.js";
import { heroMotif } from "./motif.js";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Self-contained single-file page. We deliberately inline the CSS instead of pulling
 * the Tailwind play CDN: it keeps each page ~8KB, removes a third-party script from
 * the critical path (Replay QA and the live demo both hate that), and keeps
 * Lighthouse a11y/perf high. Same design system, no runtime dependency.
 */
export function renderVariant(spec: VariantSpec): string {
  const { copy: c, palette: p, layout } = spec;
  const font = spec.font === "serif" ? FONTS.serif : FONTS.grotesk;

  const css = `
:root{--bg:${p.bg};--fg:${p.fg};--muted:${p.muted};--accent:${p.accent};--accent-fg:${p.accentFg};--surface:${p.surface};--border:${p.border}}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font-family:${font};line-height:1.55;-webkit-font-smoothing:antialiased}
.wrap{max-width:64rem;margin:0 auto;padding:0 1.25rem}
a{color:inherit}
.nav{display:flex;align-items:center;justify-content:space-between;padding:1.25rem 0;gap:1rem}
.brand{font-weight:700;letter-spacing:-.01em;font-size:1.0625rem}
.btn{display:inline-block;background:var(--accent);color:var(--accent-fg);text-decoration:none;font-weight:600;
  padding:.85rem 1.5rem;border-radius:.625rem;border:1px solid transparent;transition:filter .15s ease,transform .15s ease}
.btn:hover{filter:brightness(1.08)}
.btn:active{transform:translateY(1px)}
.btn:focus-visible,a:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
.btn-sm{padding:.55rem 1rem;font-size:.9375rem}
.hero{padding:clamp(3rem,9vw,6rem) 0 clamp(2.5rem,7vw,4.5rem)}
h1{font-size:clamp(2.1rem,6.2vw,3.75rem);line-height:1.06;letter-spacing:-.03em;margin:0 0 1rem;font-weight:800;text-wrap:balance}
.sub{font-size:clamp(1.0625rem,2.4vw,1.3125rem);color:var(--muted);margin:0 0 2rem;max-width:38ch;text-wrap:pretty}
.eyebrow{display:inline-block;font-size:.8125rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
  color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent);
  padding:.35rem .7rem;border-radius:999px;margin-bottom:1.25rem}
section{padding:clamp(2.5rem,7vw,4.5rem) 0}
h2{font-size:clamp(1.5rem,3.6vw,2.125rem);letter-spacing:-.02em;margin:0 0 2rem;font-weight:700}
.grid{display:grid;gap:1rem;grid-template-columns:1fr}
.card{background:var(--surface);border:1px solid var(--border);border-radius:.875rem;padding:1.375rem}
.card h3{margin:0 0 .5rem;font-size:1.0625rem;font-weight:650;letter-spacing:-.01em}
.card p{margin:0;color:var(--muted);font-size:.9688rem}
.price{display:flex;align-items:baseline;gap:.35rem;margin:.5rem 0 1rem}
.price b{font-size:2rem;letter-spacing:-.02em}
.price span{color:var(--muted);font-size:.9375rem}
.featured{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.cta{background:var(--surface);border:1px solid var(--border);border-radius:1.125rem;padding:clamp(1.75rem,5vw,3rem);text-align:center}
.cta h2{margin-bottom:.75rem}
.cta p{color:var(--muted);margin:0 0 1.75rem;max-width:44ch;margin-inline:auto}
footer{border-top:1px solid var(--border);padding:2rem 0 3rem;color:var(--muted);font-size:.875rem}
.embed{margin-top:1.5rem}
.panel{display:none}
.motif{display:block;width:100%;height:100%}
@media(min-width:44rem){
  .grid{grid-template-columns:repeat(3,1fr)}
  .split{display:grid;grid-template-columns:1.05fr .95fr;gap:3rem;align-items:center}
  .panel{display:block;aspect-ratio:4/3.1}
}
@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`.trim();

  const nav = `<nav class="nav" aria-label="Primary">
      <span class="brand">${esc(c.brand)}</span>
      <a class="btn btn-sm" href="#get-started">${esc(c.cta)}</a>
    </nav>`;

  const heroInner = `<p class="eyebrow">${esc(c.features[0]?.title ?? "New")}</p>
        <h1>${esc(c.headline)}</h1>
        <p class="sub">${esc(c.subhead)}</p>
        <a class="btn" href="#get-started">${esc(c.cta)}</a>`;

  const hero =
    layout === "split"
      ? `<header class="hero"><div class="wrap"><div class="split"><div>${heroInner}</div><div class="panel">${heroMotif(p, c.brand, spec.brief ?? c.subhead)}</div></div></div></header>`
      : layout === "editorial"
        ? `<header class="hero"><div class="wrap" style="max-width:48rem">${heroInner}</div></header>`
        : `<header class="hero"><div class="wrap" style="text-align:center">${heroInner.replace('class="sub"', 'class="sub" style="margin-inline:auto"')}</div></header>`;

  const features = `<section aria-labelledby="features-h"><div class="wrap">
      <h2 id="features-h">Why ${esc(c.brand)}</h2>
      <div class="grid">${c.features
        .map((f) => `<article class="card"><h3>${esc(f.title)}</h3><p>${esc(f.body)}</p></article>`)
        .join("")}</div>
    </div></section>`;

  const pricing = c.pricing?.length
    ? `<section aria-labelledby="pricing-h"><div class="wrap">
      <h2 id="pricing-h">Pricing</h2>
      <div class="grid">${c.pricing
        .map(
          (t) => `<article class="card${t.highlight ? " featured" : ""}">
          <h3>${esc(t.name)}</h3>
          <div class="price"><b>${esc(t.price)}</b></div>
          <p>${esc(t.blurb)}</p>
          <p style="margin-top:1.25rem"><a class="btn btn-sm" href="#get-started">${esc(c.cta)}</a></p>
        </article>`,
        )
        .join("")}</div>
    </div></section>`
    : "";

  const cta = `<section id="get-started"><div class="wrap"><div class="cta">
      <h2>${esc(c.cta)}</h2>
      <p>${esc(c.subhead)}</p>
      <a class="btn" href="#get-started">${esc(c.cta)}</a>
      <!-- EMBED_SLOT -->
    </div></div></section>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(c.brand)} — ${esc(c.headline)}</title>
<meta name="description" content="${esc(c.subhead)}">
<meta property="og:title" content="${esc(c.brand)}">
<meta property="og:description" content="${esc(c.subhead)}">
<style>${css}</style>
</head>
<body>
<div class="wrap">${nav}</div>
${hero}
${features}
${pricing}
${cta}
<footer><div class="wrap">${esc(c.footer)} · Built by <a href="https://landline.sh">LANDLINE</a></div></footer>
</body>
</html>`;
}
