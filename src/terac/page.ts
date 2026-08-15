import type { Variant } from "../db.js";
import { QUESTION } from "./study.js";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The page Terac panelists land on. Five questions (§5.1), three live variants in
 * iframes so testers judge the real page, not a screenshot.
 */
export function studyPage(
  orderId: string,
  variants: Variant[],
  headlines: string[],
  shotUrls: (string | null)[] = [],
): string {
  const cards = variants
    .map((v, i) => {
      const shot = shotUrls[i];
      // Screenshot when we have one (fast, and what §5.1 asks panelists to compare);
      // a live iframe when we don't, so the study is never blank.
      const media = shot
        ? `<img src="${esc(shot)}" alt="Version ${i + 1} of the landing page" loading="lazy">`
        : `<iframe src="${esc(v.preview_url ?? "")}" title="Version ${i + 1}" loading="lazy"></iframe>`;
      return `
    <figure class="card">
      <figcaption><b>Version ${i + 1}</b> <a href="${esc(v.preview_url ?? "#")}" target="_blank" rel="noopener">open full size ↗</a></figcaption>
      <div class="frame${shot ? " shot" : ""}">${media}</div>
    </figure>`;
    })
    .join("");

  const radios = (name: string, legend: string) => `
    <fieldset>
      <legend>${esc(legend)}</legend>
      ${variants
        .map(
          (v, i) =>
            `<label><input type="radio" name="${name}" value="${v.idx}" ${i === 0 ? "required" : ""}> Version ${i + 1}${
              name === "clearest_idx" && headlines[i] ? ` — “${esc(headlines[i])}”` : ""
            }</label>`,
        )
        .join("")}
    </fieldset>`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Which landing page would you click?</title>
<style>
:root{--bg:#f7f8fa;--fg:#12151a;--muted:#5c6472;--accent:#2b6cb0;--surface:#fff;--border:#e3e7ec}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:70rem;margin:0 auto;padding:1.5rem 1.25rem 4rem}
h1{font-size:1.5rem;letter-spacing:-.02em;margin:0 0 .35rem}
.lede{color:var(--muted);margin:0 0 1.75rem}
.cards{display:grid;gap:1rem;grid-template-columns:1fr}
.card{margin:0;background:var(--surface);border:1px solid var(--border);border-radius:.75rem;overflow:hidden}
figcaption{display:flex;justify-content:space-between;align-items:center;padding:.6rem .85rem;border-bottom:1px solid var(--border);font-size:.9rem}
figcaption a{color:var(--accent)}
.frame{height:26rem;overflow:hidden;background:#fff}
.frame.shot{display:block}
.frame img{width:100%;height:100%;object-fit:cover;object-position:top center;display:block}
iframe{width:200%;height:52rem;border:0;transform:scale(.5);transform-origin:0 0}
form{margin-top:2rem;background:var(--surface);border:1px solid var(--border);border-radius:.75rem;padding:1.25rem}
fieldset{border:0;padding:0;margin:0 0 1.5rem}
legend{font-weight:650;margin-bottom:.6rem;padding:0}
label{display:block;padding:.4rem 0;cursor:pointer}
input[type=radio]{margin-right:.5rem}
textarea{width:100%;min-height:4.5rem;border:1px solid var(--border);border-radius:.5rem;padding:.6rem;font:inherit;resize:vertical}
button{background:var(--accent);color:#fff;border:0;border-radius:.6rem;padding:.85rem 1.75rem;font-size:1rem;font-weight:650;cursor:pointer}
button:hover{filter:brightness(1.08)}
.trust{display:flex;gap:1rem;flex-wrap:wrap}
.trust label{display:flex;align-items:center;gap:.3rem}
.done{text-align:center;padding:4rem 1rem}
@media(min-width:60rem){.cards{grid-template-columns:repeat(3,1fr)}}
</style></head>
<body><div class="wrap">
<h1>Which of these landing pages would you actually click?</h1>
<p class="lede">Three versions of the same one-page website. Skim them, then answer five quick questions. Takes about two minutes.</p>
<div class="cards">${cards}</div>
<form method="POST" action="/study/${esc(orderId)}/vote">
  ${radios("variant_idx", QUESTION)}
  ${radios("clearest_idx", "Which headline tells you most clearly what this is?")}
  <fieldset>
    <legend>How much do you trust the version you picked? (1 = not at all, 5 = completely)</legend>
    <div class="trust">${[1, 2, 3, 4, 5]
      .map((n) => `<label><input type="radio" name="trust" value="${n}" required> ${n}</label>`)
      .join("")}</div>
  </fieldset>
  <fieldset>
    <legend>What's confusing or missing? (optional)</legend>
    <textarea name="comment" placeholder="Anything that made you hesitate"></textarea>
  </fieldset>
  <fieldset>
    <legend>Would you pay $9 for a page like the one you picked?</legend>
    <label><input type="radio" name="would_pay" value="1" required> Yes</label>
    <label><input type="radio" name="would_pay" value="0"> No</label>
  </fieldset>
  <button type="submit">Submit answers</button>
</form>
</div></body></html>`;
}

export const thanksPage = () => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Thanks</title>
<style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#f7f8fa;color:#12151a;
font:16px/1.6 ui-sans-serif,system-ui,sans-serif;text-align:center;padding:2rem}
h1{font-size:1.5rem;margin:0 0 .5rem}p{color:#5c6472;margin:0}</style></head>
<body><div><h1>Thanks — your answers are in.</h1><p>You can close this tab.</p></div></body></html>`;
