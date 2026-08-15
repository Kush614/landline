/**
 * Fills the dashboard, decisions log, Band room and /s/<slug> pages with real work
 * so nothing is empty at 7pm — even if a sponsor key never arrives.
 *
 * These run through the *actual* pipeline (agents, QA, screenshots, deploy), not
 * fixtures. The only difference from a customer order is `is_seed = 1`, which keeps
 * them out of every headline number on the dashboard, and a +1 555 01xx phone, which
 * the Linq client refuses to text.
 *
 *   npm run seed-demo                    # against localhost:3777
 *   BASE=https://landline-api.onrender.com npm run seed-demo
 */

const BASE = process.env.BASE ?? process.env.BASE_URL ?? "http://localhost:3777";
const TOKEN = process.env.INTERNAL_TOKEN ?? "";

interface SeedOrder {
  phone: string;
  brief: string;
  note: string;
  revision?: string;
  votes?: { variant: number; clearest: number; trust: number; wouldPay: boolean }[];
}

/**
 * Chosen to exercise different branches: S/M/L complexity, the e-commerce
 * specialist, a compliance veto, and a revision. Fictional businesses only —
 * nothing here should be mistaken for a real customer.
 */
const SEEDS: SeedOrder[] = [
  {
    phone: "+15550100",
    brief:
      "a landing page for Fernway, a small-batch coffee roaster in Oakland that sells monthly subscription bags to people who are bored of supermarket beans",
    note: "e-commerce → spawns the E-com Specialist, adds a pricing block, prices at the top tier",
    revision: "make it darker and change the button to Shop beans",
    // A clear human winner that disagrees with the model's default pick.
    votes: [
      { variant: 2, clearest: 2, trust: 5, wouldPay: true },
      { variant: 2, clearest: 1, trust: 4, wouldPay: true },
      { variant: 2, clearest: 2, trust: 4, wouldPay: false },
      { variant: 1, clearest: 1, trust: 3, wouldPay: true },
      { variant: 0, clearest: 0, trust: 3, wouldPay: false },
    ],
  },
  {
    phone: "+15550101",
    brief: "site for Marisol's mobile dog grooming, we come to your driveway in Daly City, first wash half price",
    note: "medium complexity, service business, no pricing block",
    votes: [
      { variant: 0, clearest: 0, trust: 4, wouldPay: true },
      { variant: 0, clearest: 2, trust: 5, wouldPay: true },
      { variant: 1, clearest: 1, trust: 3, wouldPay: false },
    ],
  },
  {
    phone: "+15550102",
    brief: "one page for a two-person structural engineering studio taking on seismic retrofits in the East Bay",
    note: "short brief → S complexity → $9 tier",
    votes: [
      { variant: 1, clearest: 1, trust: 5, wouldPay: true },
      { variant: 1, clearest: 1, trust: 4, wouldPay: true },
    ],
  },
  {
    phone: "+15550103",
    brief: "a supplement that cures anxiety, guaranteed results in 7 days",
    note: "COMPLIANCE VETO — declined, never built. This is the one to show judges.",
  },
];

const headers = { "content-type": "application/json", "x-internal-token": TOKEN };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function vote(orderId: string, v: SeedOrder["votes"] extends (infer T)[] | undefined ? T : never) {
  const body = new URLSearchParams({
    variant_idx: String(v.variant),
    clearest_idx: String(v.clearest),
    trust: String(v.trust),
    would_pay: v.wouldPay ? "1" : "0",
  });
  await fetch(`${BASE}/study/${orderId}/vote`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

async function main() {
  console.log(`Seeding demo data against ${BASE}\n`);

  const health = await fetch(`${BASE}/health`).then((r) => r.json()).catch(() => null);
  if (!health?.ok) {
    console.error(`✗ ${BASE} is not responding. Start the server first (npm run dev).`);
    process.exit(1);
  }
  console.log(`Sponsors live: ${health.sponsors_live} — ${health.summary}\n`);

  const results: { note: string; status: string; url?: string }[] = [];

  for (const [i, seed] of SEEDS.entries()) {
    console.log(`[${i + 1}/${SEEDS.length}] ${seed.note}`);
    console.log(`    "${seed.brief.slice(0, 78)}${seed.brief.length > 78 ? "…" : ""}"`);

    try {
      const res = await post("/internal/seed", { phone: seed.phone, brief: seed.brief });
      const order = res?.order;

      if (res?.declined) {
        console.log(`    → DECLINED by compliance: ${order?.compliance_reason}\n`);
        results.push({ note: seed.note, status: `declined (${order?.compliance_reason})` });
        continue;
      }
      if (!order?.deploy_url) {
        console.log(`    → did not reach live (status=${order?.status})\n`);
        results.push({ note: seed.note, status: `incomplete (${order?.status})` });
        continue;
      }

      console.log(`    → live: ${order.deploy_url}  [${order.tier}, complexity ${order.complexity}]`);

      // Human votes, so the study page and the override rate aren't empty.
      if (seed.votes?.length) {
        for (const v of seed.votes) await vote(order.id, v);
        console.log(`    → ${seed.votes.length} human votes recorded`);

        // Votes arrive after we've already shipped the model's pick — the same
        // situation §4.4 handles in production. Re-running human_test makes the
        // panel's verdict count, and re-deploying ships whatever they chose.
        const retested = await post("/internal/steps/human_test", { orderId: order.id });
        const winner = retested?.result?.winnerIdx;
        await post("/internal/steps/qa", { orderId: order.id });
        await post("/internal/steps/deploy", { orderId: order.id });
        console.log(
          `    → humans picked variant ${winner! + 1}` +
            (winner === 0 ? " (agreed with the model)" : " — overrode the model's pick, page redeployed"),
        );
      }

      if (seed.revision) {
        await post("/webhooks/linq", {
          data: { chat_id: `seed-${seed.phone}`, from: seed.phone, parts: [{ type: "text", value: seed.revision }] },
        });
        await sleep(2500);
        console.log(`    → revision applied: "${seed.revision}"`);
      }

      results.push({ note: seed.note, status: "live", url: order.deploy_url });
      console.log();
    } catch (err) {
      console.error(`    ✗ ${err instanceof Error ? err.message : String(err)}\n`);
      results.push({ note: seed.note, status: "error" });
    }
  }

  const d = await fetch(`${BASE}/api/dashboard`).then((r) => r.json());
  console.log("─".repeat(70));
  console.log("Seeded:");
  for (const r of results) console.log(`  ${r.status.padEnd(28)} ${r.url ?? r.note.slice(0, 40)}`);
  console.log("─".repeat(70));
  console.log(`Dashboard now shows:`);
  console.log(`  real sites shipped:      ${d.sites_shipped}`);
  console.log(`  seeded sites shipped:    ${d.seeded_sites_shipped}   (excluded from every headline number)`);
  console.log(`  human votes:             ${d.human_votes}`);
  console.log(`  humans overrode model:   ${d.humans_overrode_model}`);
  console.log(`  would pay $9:            ${d.pricing_study.would_pay_9}/${d.pricing_study.asked}`);
  console.log(`  agent decisions logged:  ${d.agent_decisions}`);
  console.log(`\nSeeded orders use +1 555 01xx (reserved-for-fiction) so no real texts are sent.`);
}

await main();
