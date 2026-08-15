import { db, type Order } from "../db.js";
import { config } from "../config.js";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * The storefront. Also the app's entrypoint for crawlers and QA: without a page at
 * `/`, Replay QA blocks the whole project on "target URL returned 404". Every live
 * order links out to its page and its study, so an explorer has real journeys to
 * follow rather than a bare API root.
 */
export function indexPage(d: Record<string, any>): string {
  const orders = db
    .prepare(
      `SELECT id, slug, deploy_url, tier, complexity, is_seed, winner_idx, qa_status
       FROM orders WHERE status = 'live' AND deploy_url IS NOT NULL
       ORDER BY created_at DESC LIMIT 12`,
    )
    .all() as Pick<Order, "id" | "slug" | "deploy_url" | "tier" | "complexity" | "is_seed" | "winner_idx" | "qa_status">[];

  const phone = config.linq.phoneNumber || "";
  const prettyPhone = phone.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, "($1) $2-$3") || "not configured";

  const stat = (label: string, value: string, note = "") =>
    `<div class="stat"><dt>${esc(label)}</dt><dd>${esc(value)}</dd>${note ? `<p>${esc(note)}</p>` : ""}</div>`;

  const rows = orders.length
    ? orders
        .map(
          (o) => `<tr>
      <td><a href="/s/${esc(o.slug ?? "")}">${esc(o.slug ?? "")}</a>${o.is_seed ? ' <span class="tag">demo</span>' : ""}</td>
      <td>${esc(o.tier)}</td>
      <td>${esc(o.complexity ?? "—")}</td>
      <td>${o.qa_status === "CLEAN" ? "QA clean" : esc(o.qa_status ?? "—")}</td>
      <td class="links">
        <a href="/s/${esc(o.slug ?? "")}/v0">v0</a>
        <a href="/s/${esc(o.slug ?? "")}/v1">v1</a>
        <a href="/s/${esc(o.slug ?? "")}/v2">v2</a>
        <a href="/study/${esc(o.id)}">study</a>
      </td>
    </tr>`,
        )
        .join("")
    : `<tr><td colspan="5" class="empty">No sites shipped yet. Text the number above and one appears here.</td></tr>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LANDLINE — a landing-page agency that lives in a phone number</title>
<meta name="description" content="Text a description of your business and get a live, human-tested, QA-certified one-page website back. No humans involved.">
<style>
:root{--bg:#0b0d10;--fg:#f4f6f8;--muted:#9aa4b2;--accent:#5b8cff;--accent-fg:#06080c;--surface:#14181e;--border:#232a33}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);line-height:1.55;
  font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Inter,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:64rem;margin:0 auto;padding:0 1.25rem}
a{color:var(--accent)}
a:focus-visible,button:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
header{padding:clamp(3rem,8vw,5rem) 0 2rem}
.brand{font-weight:700;letter-spacing:.14em;font-size:.8125rem;text-transform:uppercase;color:var(--muted)}
h1{font-size:clamp(2rem,5.4vw,3.25rem);line-height:1.08;letter-spacing:-.03em;margin:.75rem 0 1rem;font-weight:800;max-width:20ch}
.lede{font-size:clamp(1.0625rem,2.2vw,1.25rem);color:var(--muted);margin:0 0 2rem;max-width:52ch}
.cta{display:inline-flex;align-items:center;gap:.6rem;background:var(--accent);color:var(--accent-fg);
  text-decoration:none;font-weight:650;padding:.9rem 1.5rem;border-radius:.7rem;font-size:1.0625rem}
.cta:hover{filter:brightness(1.08)}
.hint{color:var(--muted);font-size:.9375rem;margin-top:.85rem}
section{padding:2.5rem 0;border-top:1px solid var(--border)}
h2{font-size:1.375rem;letter-spacing:-.01em;margin:0 0 1.25rem;font-weight:700}
dl.stats{display:grid;gap:1rem;grid-template-columns:repeat(2,1fr);margin:0}
.stat{background:var(--surface);border:1px solid var(--border);border-radius:.75rem;padding:1rem 1.1rem}
.stat dt{color:var(--muted);font-size:.8125rem;margin:0 0 .3rem}
.stat dd{margin:0;font-size:1.625rem;font-weight:700;letter-spacing:-.02em}
.stat p{margin:.3rem 0 0;color:var(--muted);font-size:.8125rem}
table{width:100%;border-collapse:collapse;font-size:.9375rem}
th,td{text-align:left;padding:.65rem .6rem;border-bottom:1px solid var(--border);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:.8125rem;text-transform:uppercase;letter-spacing:.05em}
td.links a{margin-right:.6rem}
.tag{display:inline-block;font-size:.6875rem;text-transform:uppercase;letter-spacing:.06em;
  color:var(--muted);border:1px solid var(--border);border-radius:999px;padding:.1rem .45rem;margin-left:.35rem}
.empty{color:var(--muted)}
.scroll{overflow-x:auto}
ol{color:var(--muted);padding-left:1.2rem;max-width:60ch}
ol li{margin-bottom:.5rem}
ol b{color:var(--fg);font-weight:650}
footer{border-top:1px solid var(--border);padding:2rem 0 3rem;color:var(--muted);font-size:.875rem}
footer a{margin-right:1rem}
@media(min-width:44rem){dl.stats{grid-template-columns:repeat(4,1fr)}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <p class="brand">LANDLINE</p>
    <h1>A landing-page agency that lives in a phone number.</h1>
    <p class="lede">Text a description of your business. Three versions get built, real people vote on which one works, the winner is QA'd and deployed. You get a link back in about a minute.</p>
    <a class="cta" href="sms:${esc(phone)}">Text ${esc(prettyPhone)}</a>
    <p class="hint">No app, no account, no forms. The phone number is the whole product.</p>
  </header>

  <section aria-labelledby="how-h">
    <h2 id="how-h">How it works</h2>
    <ol>
      <li><b>You text a brief.</b> "A landing page for my coffee roastery in Oakland."</li>
      <li><b>Six agents pick it up.</b> A designer sizes the job, a copywriter writes three angles, compliance checks it's something we can ethically build.</li>
      <li><b>Real people choose.</b> Three variants go to a panel. Their pick beats the model's — they overrode it on ${esc(String(Math.round((d.human_override_rate ?? 0) * 100)))}% of pages so far.</li>
      <li><b>QA, then live.</b> Automated tests run against the winner. Broken buttons go back to the copywriter, not a patch script.</li>
      <li><b>Text a change any time.</b> "Make it darker." Your page rebuilds and redeploys.</li>
    </ol>
  </section>

  <section aria-labelledby="stats-h">
    <h2 id="stats-h">Live numbers</h2>
    <dl class="stats">
      ${stat("Sites shipped", String(d.sites_shipped ?? 0), d.seeded_sites_shipped ? `+${d.seeded_sites_shipped} demo` : "")}
      ${stat("Human votes", String(d.human_votes ?? 0))}
      ${stat("Humans overrode the model", `${Math.round((d.human_override_rate ?? 0) * 100)}%`)}
      ${stat("Revenue", money(d.revenue_cents ?? 0), d.revenue_mode === "test" ? "test mode — not real money" : "")}
    </dl>
  </section>

  <section aria-labelledby="sites-h">
    <h2 id="sites-h">Pages we've shipped</h2>
    <div class="scroll">
      <table>
        <thead><tr><th>Site</th><th>Tier</th><th>Size</th><th>QA</th><th>Variants</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>

  <footer>
    <a href="/api/dashboard">Dashboard JSON</a>
    <a href="/health">Health</a>
    <a href="https://github.com/Kush614/landline">Source</a>
  </footer>
</div>
</body>
</html>`;
}
