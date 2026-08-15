import { config } from "../config.js";
import { logDecision } from "../log.js";
import * as band from "../band/client.js";
import type { Complexity } from "../builder/types.js";

export interface Pricing {
  tier: "starter" | "certified" | "care";
  amountCents: number;
  label: string;
  blurb: string;
}

const TIERS: Record<Complexity, Pricing> = {
  S: { tier: "starter", amountCents: 900, label: "$9", blurb: "One page, live now, yours to keep." },
  M: {
    tier: "certified",
    amountCents: 1900,
    label: "$19",
    blurb: "One page + QA certificate + your own subdomain.",
  },
  L: {
    tier: "care",
    amountCents: 2900,
    label: "$29/mo",
    blurb: "Page + QA certificate + site care: text us any change, any time.",
  },
};

/**
 * Sales agent (§3.3.1). Hard dependency: it blocks on the Designer's complexity
 * estimate arriving in the Band thread. No estimate in the room => no price,
 * which is exactly what the BAND_ENABLED=false kill-switch proves (§7.8).
 */
export async function priceOrder(thread: string, orderId: string): Promise<Pricing> {
  const est = await band.waitFor(
    (m) => m.thread === thread && m.from === "designer" && m.type === "complexity_estimate",
  );

  const complexity = ((est.data as { complexity?: Complexity })?.complexity ?? "S") as Complexity;
  const pricing = TIERS[complexity] ?? TIERS.S;

  logDecision({
    agent: "sales",
    type: "price_set",
    orderId,
    bandDependency: "sales_blocks_on_designer",
    input: { unblockedBy: est.id, complexity },
    output: pricing,
  });

  await band.post({
    thread,
    from: "sales",
    mentions: ["ceo"],
    type: "price_set",
    body: `${pricing.label} — ${pricing.blurb}`,
    data: pricing,
    orderId,
  });

  return pricing;
}

export { TIERS };
