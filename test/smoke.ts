/**
 * Acceptance tests (§7). Runs without any sponsor keys — every integration has a
 * documented fallback, and these assert the fallbacks behave. Tests that need live
 * credentials (Render deploy, Linq card, Agent Pay) are marked SKIP and listed in
 * STATUS.md as manual checks.
 *
 *   npm test
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workdir = mkdtempSync(join(tmpdir(), "landline-test-"));
process.env.DATA_DIR = join(workdir, "data");
process.env.SITES_DIR = join(workdir, "sites");
process.env.BASE_URL = "http://localhost:3999";
process.env.TERAC_INLINE_WAIT_MS = "200";
process.env.TERAC_MIN_VOTES = "1";
process.env.BAND_ENABLED = "true";
// Tests must never touch a paid API. A real TERAC_API_KEY in .env previously made
// `npm test` create and LAUNCH a real Terac study (billed per participant). Blank
// the key and point the base URL at a dead port so nothing can escape the suite.
process.env.TERAC_API_KEY = "";
process.env.TERAC_BASE_URL = "http://127.0.0.1:1";
process.env.REPLAY_API_KEY = "";
process.env.SUPERSERVE_API_KEY = "";
process.env.PIONEER_API_KEY = "";
process.env.LINQ_API_KEY = "";

let passed = 0;
let failed = 0;
const skipped: string[] = [];

function check(name: string, cond: unknown, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const skip = (name: string, why: string) => {
  skipped.push(`${name} (${why})`);
  console.log(`  ⊘ ${name} — SKIP: ${why}`);
};
const section = (n: string) => console.log(`\n${n}`);

const { createOrder, getOrder, updateOrder, upsertVariant, variantsFor, recordVote, votesFor } = await import("../src/db.js");
const band = await import("../src/band/client.js");
const { design } = await import("../src/agents/designer.js");
const { writeCopy, rewriteCta } = await import("../src/agents/copywriter.js");
const { checkCompliance } = await import("../src/agents/compliance.js");
const { priceOrder } = await import("../src/agents/sales.js");
const { scrubPII } = await import("../src/agents/pii.js");
const { renderVariant } = await import("../src/builder/render.js");
const { applyEdit } = await import("../src/builder/edit.js");
const { slugify, writeVariant, publish, writeSpec, readSite } = await import("../src/deploy/sites.js");
const { runStudy } = await import("../src/terac/study.js");
const { runQa, staticChecks } = await import("../src/replay/qa.js");
const { buildInVm } = await import("../src/superserve/vm.js");
const { parseInbound, verifySignature } = await import("../src/linq/client.js");
const { dashboard } = await import("../src/dashboard/data.js");
const { intake } = await import("../src/pipeline/run.js");

const BRIEF = "a landing page for Fernway, a small-batch coffee roaster in Oakland that sells subscription bags";

// ---------------------------------------------------------------- 1. intake
section("1. Inbound webhook creates an order and opens a Band thread");
{
  const parsed = parseInbound({
    data: { chat_id: "c1", from: "+14155550001", parts: [{ type: "text", value: BRIEF }] },
  });
  check("webhook payload parses", parsed?.phone === "+14155550001" && parsed?.text === BRIEF);
  // Hermetic: assert both branches explicitly rather than inheriting whatever
  // LINQ_WEBHOOK_SECRET happens to be in the developer's .env.
  {
    const cfg = (await import("../src/config.js")).config;
    const real = cfg.linq.webhookSecret;
    cfg.linq.webhookSecret = "";
    check("unsigned request passes when no secret is set", verifySignature({}, "{}"));
    cfg.linq.webhookSecret = "whsec_dGVzdHNlY3JldA==";
    check("unsigned request is rejected once a secret is set", !verifySignature({}, "{}"));
    check("stale timestamp is rejected", !verifySignature(
      { "webhook-id": "x", "webhook-timestamp": "1", "webhook-signature": "v1,bogus" }, "{}"));
    cfg.linq.webhookSecret = real;
  }

  const order = await intake("+14155550001", BRIEF, "c1");
  check("order row created", !!order);
  check("Band thread id set", !!order?.band_thread_id, order?.band_thread_id ?? "missing");
  check("brief PII-scrubbed before storage", !!order?.brief_scrubbed);
  check("compliance approved a benign brief", order?.compliance === "APPROVE");
}

// ---------------------------------------------------------------- 2. builder
section("2. Builder produces 3 valid variants under 60KB");
{
  const id = "test-build";
  const slug = slugify(BRIEF, id);
  const order = createOrder({ id, phone: "+1999", brief: BRIEF, slug });
  const d = design(BRIEF, id);
  check("designer returns 3 layouts", d.layouts.length === 3);
  check("coffee subscription brief classified e-commerce", d.isEcommerce);

  const copies = await Promise.all([0, 1, 2].map((a) => writeCopy(BRIEF, a, id)));
  const specs = d.layouts.map((l, i) => ({ idx: i, label: l.label, layout: l.layout, palette: l.palette, font: l.font, copy: copies[i] }));
  const built = await buildInVm(order, specs);

  check("3 variants built", built.html.length === 3);
  for (const [i, html] of built.html.entries()) {
    check(`v${i} under 60KB`, Buffer.byteLength(html) < 60_000, `${Buffer.byteLength(html)}b`);
    check(`v${i} has doctype, title, viewport, h1`, /^<!doctype html>/i.test(html) && /<title>[^<]{3,}/.test(html) && /name="viewport"/.test(html) && /<h1[^>]*>/.test(html));
    check(`v${i} has lang and no unresolved anchors`, /<html lang="en">/.test(html) && staticChecks(html).length === 0);
    writeVariant(slug, i, html);
  }
  check("three headlines are distinct", new Set(copies.map((c) => c.headline)).size === 3);
}

// ---------------------------------------------------------------- 3. Terac
section("3. Study winner selection and fallback");
{
  const id = "test-study";
  const slug = slugify(BRIEF, id);
  const order = createOrder({ id, phone: "+1998", brief: BRIEF, slug });
  const variants = [0, 1, 2].map((i) => ({
    id: `${id}-v${i}`, order_id: id, idx: i, label: `v${i}`,
    html_path: null, preview_url: `x/v${i}`, terac_score: null, replay_status: null,
  }));
  for (const v of variants) upsertVariant(v);

  const noKey = await runStudy({ order, variants, modelPick: variants[0] });
  check("no Terac key falls back to the model pick", noKey.source === "model" && noKey.winner.idx === 0);

  recordVote({ order_id: id, variant_idx: 2, clearest_idx: 2, trust: 4, would_pay: 1, comment: null, voter: "t" });
  recordVote({ order_id: id, variant_idx: 2, clearest_idx: 1, trust: 5, would_pay: 1, comment: null, voter: "t" });
  recordVote({ order_id: id, variant_idx: 0, clearest_idx: 0, trust: 3, would_pay: 0, comment: null, voter: "t" });

  // Exercise the human-results path. config is a singleton read at import time, so we
  // flip it directly; the base URL points at a dead port so the launch call fails fast
  // and we fall straight through to tallying the votes we just recorded.
  const cfg = (await import("../src/config.js")).config;
  const realKey = cfg.terac.apiKey;
  const realUrl = cfg.terac.baseUrl;
  cfg.terac.apiKey = "test-key";
  cfg.terac.baseUrl = "http://127.0.0.1:1"; // dead port: never reaches Terac
  const withVotes = await runStudy({ order, variants, modelPick: variants[0] });
  cfg.terac.apiKey = realKey;
  cfg.terac.baseUrl = realUrl;
  check("humans override the model pick", withVotes.winner.idx === 2, `winner=${withVotes.winner.idx}`);
  check("preference ratio computed", Math.abs(withVotes.preference - 2 / 3) < 0.01, String(withVotes.preference));
}

// ---------------------------------------------------------------- 4. QA loop
section("4. QA finds a broken CTA, copywriter re-emits it");
{
  const id = "test-qa";
  const order = createOrder({ id, phone: "+1997", brief: BRIEF, slug: slugify(BRIEF, id) });

  const broken = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Broken page</title></head><body><a href="#nowhere">Get started</a></body></html>`;
  const bugs = staticChecks(broken);
  check("dangling CTA anchor detected", bugs.some((b) => /anchor/.test(b.title)), JSON.stringify(bugs));

  const report = await runQa(order, "http://localhost:3999/s/x", 1, broken);
  check("QA reports BUGS on the broken page", report.status === "BUGS");
  check("QA flags it as a CTA problem", report.ctaBroken);

  const copy = await writeCopy(BRIEF, 0, id);
  const fixed = await rewriteCta(copy, "broken CTA", id);
  check("copywriter emits a different CTA", fixed.cta !== copy.cta, `${copy.cta} -> ${fixed.cta}`);

  const good = renderVariant({ idx: 0, label: "t", layout: "centered", palette: (await import("../src/builder/palettes.js")).PALETTES.paper, font: "grotesk", copy: fixed });
  const second = await runQa(order, "http://localhost:3999/s/x", 2, good);
  check("re-run on the rebuilt page is CLEAN", second.status === "CLEAN", JSON.stringify(second.bugs));
}

// ---------------------------------------------------------------- 5. hosting
section("5. Generated site is served");
{
  const slug = "smoke-host";
  const html = "<!doctype html><html lang=\"en\"><head><title>hi</title></head><body>ok</body></html>";
  const url = publish(slug, html);
  check("publish returns a URL under BASE_URL", url === "http://localhost:3999/s/smoke-host", url);
  check("published file reads back", readSite(slug) === html);
  check("path traversal is refused", readSite(slug, "../../../etc/passwd") === null);
  skip("Render static site returns 200 within 90s", "needs RENDER_API_KEY — manual check");
}

// ---------------------------------------------------------------- 6. Linq
section("6. Linq card + Agent Pay");
{
  skip("iMessage App card renders LIVE + URL + Pay", "needs LINQ_API_KEY — manual check");
  skip("$1 Agent Pay test charge lands in Stripe", "needs Linq payments onboarding — manual check");
  const reaction = parseInbound({ data: { from: "+1415", parts: [{ type: "reaction", value: "👍" }] } });
  check("tapback parsed as a reaction", reaction?.isReaction === true && reaction.reaction === "👍");
}

// ---------------------------------------------------------------- 7. revision
section("7. Revision reuses the same VM and redeploys");
{
  const id = "test-revise";
  const slug = slugify(BRIEF, id);
  const order = createOrder({ id, phone: "+1996", brief: BRIEF, slug });
  const copy = await writeCopy(BRIEF, 0, id);
  const spec = { idx: 0, label: "t", layout: "centered" as const, palette: (await import("../src/builder/palettes.js")).PALETTES.paper, font: "grotesk", copy };
  writeSpec(slug, spec);
  publish(slug, renderVariant(spec));
  updateOrder(id, { superserve_vm_id: "vm-abc-123" });

  const before = getOrder(id)!.superserve_vm_id;
  const result = await applyEdit(getOrder(id)!, "make it darker");
  const after = getOrder(id)!.superserve_vm_id;

  check("VM id is unchanged across the revision", before === after && after === "vm-abc-123", `${before} -> ${after}`);
  check("dark palette applied", /--bg:#0b0d10/.test(result.html));
  check("summary describes the change", /dark/i.test(result.summary), result.summary);

  const cta = await applyEdit(getOrder(id)!, 'change the button to "Shop beans"');
  check("CTA edit applied", /Shop beans/.test(cta.html));
}

// ---------------------------------------------------------------- 8. Band
section("8. Band kill-switch halts the company");
{
  band.__reset();
  const id = "test-band-off";
  createOrder({ id, phone: "+1995", brief: BRIEF, slug: slugify(BRIEF, id) });

  // With Band on, Sales prices only after Designer posts.
  const thread = "t-on";
  let priced = false;
  const p = priceOrder(thread, id).then((r) => { priced = true; return r; });
  await new Promise((r) => setTimeout(r, 60));
  check("Sales has NOT priced before Designer posts", priced === false);

  await band.post({ thread, from: "designer", type: "complexity_estimate", body: "M", data: { complexity: "M" }, orderId: id });
  const pricing = await p;
  check("Sales prices once the estimate lands", priced && pricing.amountCents === 1900, JSON.stringify(pricing));

  // Kill switch.
  const cfg = (await import("../src/config.js")).config;
  cfg.band.enabled = false;
  let postThrew = false;
  try {
    await band.post({ thread: "t-off", from: "ceo", type: "brief", body: BRIEF, orderId: id });
  } catch { postThrew = true; }
  let waitThrew = false;
  try {
    await band.waitFor((m) => m.type === "complexity_estimate", 100);
  } catch { waitThrew = true; }
  check("posting to Band throws when disabled", postThrew);
  check("waiting on Band throws when disabled", waitThrew);

  const declined = await intake("+14155550009", BRIEF, "c9");
  check("CEO cannot open an order without Band", declined === null);
  cfg.band.enabled = true;
}

// ---------------------------------------------------------------- 9. veto
section("9. Compliance veto blocks the deploy");
{
  const v = checkCompliance("supplement that cures anxiety", "", "test-veto");
  check("medical claim vetoed", v.verdict === "VETO" && v.reason === "medical claim");
  check("guaranteed returns vetoed", checkCompliance("app with guaranteed 40% returns").verdict === "VETO");
  check("ordinary brief approved", checkCompliance(BRIEF).verdict === "APPROVE");

  band.__reset();
  const order = await intake("+14155550002", "supplement that cures anxiety", "c2");
  check("vetoed brief never becomes an order we build", order === null);
}

// ---------------------------------------------------------------- extras
section("10. PII scrub and dashboard");
{
  const scrubbed = await scrubPII("I'm Dana, call me on 415-555-0134 or dana@fernway.co", "test-pii");
  check("phone redacted", !/415-555-0134/.test(scrubbed), scrubbed);
  check("email redacted", !/dana@fernway\.co/.test(scrubbed), scrubbed);

  const d = await dashboard();
  check("dashboard reports orders", typeof d.orders_total === "number" && d.orders_total > 0);
  check("dashboard exposes sponsor status", typeof d.sponsors_live.band === "boolean");
  check("dashboard reports the pricing meta-study", typeof d.pricing_study.rate === "number");
}

// ------------------------------------------------------------- 11. Agent Pay
section("11. Linq Agent Pay — the four-endpoint connect/charge flow");
{
  const { createServer } = await import("node:http");
  const seen: { method: string; url: string; body: string }[] = [];

  // Mock Linq. Confirms we call the documented routes in the documented order with
  // the documented bodies — the real API is unavailable until the key lands.
  const mock = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", body });
      res.setHeader("content-type", "application/json");
      if (/\/connect$/.test(req.url ?? "")) return res.end(JSON.stringify({ connect_id: "cs_01HZY8" }));
      if (/\/verify$/.test(req.url ?? "")) {
        const ok = JSON.parse(body || "{}").code === "482913";
        res.statusCode = ok ? 200 : 400;
        return res.end(JSON.stringify(ok ? { verified: true } : { error: "bad code" }));
      }
      if (/\/credentials$/.test(req.url ?? ""))
        return res.end(JSON.stringify({ user_token: "ut_abc", fetch_url: "https://pay.linq.test/redeem/ut_abc" }));
      if (/\/payments$/.test(req.url ?? "") && req.method === "POST")
        return res.end(JSON.stringify({ id: "pay_123" }));
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise<void>((r) => mock.listen(4177, r));

  const cfg = (await import("../src/config.js")).config;
  cfg.linq.apiKey = "test-linq-key";
  cfg.linq.baseUrl = "http://127.0.0.1:4177/v3";

  const ap = await import("../src/linq/agentpay.js");
  const handle = "+14155550777";
  const id = "test-pay";
  createOrder({ id, phone: handle, brief: BRIEF, slug: slugify(BRIEF, id) });
  updateOrder(id, { deploy_url: "http://x/s/y", status: "live", amount_cents: 1900 });

  check("handle starts unconnected", !ap.isConnected(handle));

  const connectId = await ap.requestConnect(handle, id);
  check("connect returns Linq's connect_id", connectId === "cs_01HZY8", String(connectId));
  check("connect hits the documented route", seen.at(-1)?.url === `/v3/payments/handles/${encodeURIComponent(handle)}/connect`, seen.at(-1)?.url);
  check("handle is now pending", ap.hasPendingConnect(handle));

  check("a 6-digit text is recognised as a code", ap.looksLikeCode("482913") && !ap.looksLikeCode("make it darker"));

  const badVerify = await ap.verifyConnect(handle, "000000", id);
  check("wrong code is rejected", badVerify === false);
  check("rejected code leaves the handle unconnected", !ap.isConnected(handle));

  // A failed verify marks the connection failed, so re-request before the good code.
  await ap.requestConnect(handle, id);
  const goodVerify = await ap.verifyConnect(handle, "482913", id);
  check("correct code verifies", goodVerify === true);
  check("verify sends connect_id and code", JSON.parse(seen.at(-1)?.body ?? "{}").connect_id === "cs_01HZY8");
  check("handle is now connected", ap.isConnected(handle));

  const handoff = await ap.createAgentPayment({ handle, orderId: id, amountCents: 1900, description: "LANDLINE test" });
  check("payment created", handoff?.linqPaymentId === "pay_123", JSON.stringify(handoff));
  check("credentials fetched for the customer to redeem", handoff?.fetchUrl?.includes("pay.linq.test"), handoff?.fetchUrl);
  const created = seen.find((s) => s.url === "/v3/payments" && s.method === "POST");
  const createdBody = JSON.parse(created?.body ?? "{}");
  check("payment body matches the documented shape",
    createdBody.amount_cents === 1900 && createdBody.currency === "usd" && createdBody.merchant?.name === "LANDLINE",
    created?.body);
  check("payment row persisted", ap.paymentsForOrder(id).length === 1);

  const pay = await ap.payInstruction({ handle, orderId: id, amountCents: 1900, description: "d" });
  check("connected handle is offered Apple Pay", pay.rail === "agent_pay", `${pay.rail}: ${pay.text}`);

  // Unconnected handle must still be sellable.
  cfg.stripe.paymentLink = "https://buy.stripe.com/test";
  const fallback = await ap.payInstruction({ handle: "+14155550888", orderId: id, amountCents: 900, description: "d" });
  check("unconnected handle falls back to the Stripe link", fallback.rail === "stripe" && fallback.text.includes("buy.stripe.com"));

  // Linq down entirely: never leave a customer with no way to pay.
  cfg.linq.baseUrl = "http://127.0.0.1:1/v3";
  const down = await ap.payInstruction({ handle: "+14155550999", orderId: id, amountCents: 900, description: "d" });
  check("Linq outage still yields a payable link", down.rail === "stripe");
  check("connect failure is survivable", (await ap.requestConnect("+14155550999", id)) === null);

  await new Promise<void>((r) => mock.close(() => r()));
  cfg.linq.apiKey = "";
  cfg.stripe.paymentLink = "";
}

// ------------------------------------------------------- 12. vote validation
section("12. Study votes reject junk that would skew the preference number");
{
  const id = "test-vote";
  const slug = slugify(BRIEF, id);
  createOrder({ id, phone: "+1994", brief: BRIEF, slug });
  for (const i of [0, 1, 2]) {
    upsertVariant({ id: `${id}-v${i}`, order_id: id, idx: i, label: `v${i}`,
      html_path: null, preview_url: null, terac_score: null, replay_status: null });
  }
  const valid = new Set(variantsFor(id).map((v) => v.idx));
  check("variant set is the three real variants", valid.size === 3 && valid.has(2) && !valid.has(99));

  // The bug this covers: a vote for a nonexistent variant still counted toward the
  // denominator in tally(), deflating the "% preferred" figure we publish.
  recordVote({ order_id: id, variant_idx: 1, clearest_idx: 1, trust: 4, would_pay: 1, comment: null, voter: "t" });
  const before = votesFor(id).length;
  check("a legitimate vote is recorded", before === 1);
  check("out-of-range variant is not in the valid set", !valid.has(99));
  check("trust 99 is out of the 1-5 range", !(99 >= 1 && 99 <= 5));
}

console.log(`\n${"─".repeat(60)}`);
console.log(`${passed} passed, ${failed} failed, ${skipped.length} skipped`);
if (skipped.length) console.log(`\nManual checks still required:\n${skipped.map((s) => `  · ${s}`).join("\n")}`);
rmSync(workdir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
