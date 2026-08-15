import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { config, has } from "../config.js";
import { req, softly } from "../http.js";
import { db, wouldPayStats } from "../db.js";

interface Counts {
  n: number;
}

let stripeCache: { at: number; cents: number; count: number } | null = null;

/** Read-only Stripe balance/charges via the restricted key we submitted (§5.2). */
async function stripeRevenue(): Promise<{ cents: number; count: number }> {
  if (!config.stripe.readKey) return { cents: 0, count: 0 };
  if (stripeCache && Date.now() - stripeCache.at < 30_000) {
    return { cents: stripeCache.cents, count: stripeCache.count };
  }
  const result = await softly(
    "stripe.charges",
    async () => {
      const res = await req<{ data: { amount: number; paid: boolean; refunded: boolean }[] }>(
        "https://api.stripe.com/v1/charges?limit=100",
        { headers: { Authorization: `Bearer ${config.stripe.readKey}` } },
      );
      const paid = (res.data ?? []).filter((c) => c.paid && !c.refunded);
      return { cents: paid.reduce((s, c) => s + c.amount, 0), count: paid.length };
    },
    { cents: 0, count: 0 },
  );
  stripeCache = { at: Date.now(), ...result };
  return result;
}

const jsonlCount = (file: string) => {
  const path = resolve(process.cwd(), "logs", file);
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").split("\n").filter(Boolean).length;
};

export async function dashboard() {
  const shipped = (db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE status = 'live'`).get() as Counts).n;
  const orders = (db.prepare(`SELECT COUNT(*) AS n FROM orders`).get() as Counts).n;
  const declined = (db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE status = 'declined'`).get() as Counts).n;
  const studies = (db.prepare(`SELECT COUNT(*) AS n FROM studies`).get() as Counts).n;
  const qaPasses = (
    db.prepare(`SELECT COUNT(*) AS n FROM variants WHERE replay_status = 'CLEAN'`).get() as Counts
  ).n;
  const votes = (db.prepare(`SELECT COUNT(*) AS n FROM votes`).get() as Counts).n;

  const overrides = db
    .prepare(
      `SELECT COUNT(*) AS n FROM studies
       WHERE winner_variant_id IS NOT NULL
         AND model_pick_variant_id IS NOT NULL
         AND winner_variant_id <> model_pick_variant_id`,
    )
    .get() as Counts;

  const booked = (
    db.prepare(`SELECT COALESCE(SUM(amount_cents),0) AS c FROM orders WHERE status = 'live'`).get() as {
      c: number;
    }
  ).c;

  const pay = wouldPayStats();
  const revenue = await stripeRevenue();

  return {
    updated_at: new Date().toISOString(),
    revenue_cents: revenue.cents,
    revenue_source: config.stripe.readKey ? "stripe" : "unconfigured",
    charges: revenue.count,
    booked_cents: booked,
    sites_shipped: shipped,
    orders_total: orders,
    orders_declined_by_compliance: declined,
    terac_studies_run: studies,
    human_votes: votes,
    humans_overrode_model: overrides.n,
    human_override_rate: studies ? overrides.n / studies : 0,
    qa_passes: qaPasses,
    agent_decisions: jsonlCount("decisions.jsonl"),
    pricing_study: {
      asked: pay.n,
      would_pay_9: pay.yes,
      rate: pay.n ? pay.yes / pay.n : 0,
    },
    sponsors_live: {
      linq: has.linq(),
      stripe: has.stripe(),
      terac: has.terac(),
      replay: has.replay(),
      superserve: has.superserve(),
      pioneer: has.pioneer(),
      band: has.band(),
      render: has.render(),
    },
  };
}
