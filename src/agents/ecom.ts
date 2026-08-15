import { logDecision } from "../log.js";
import type { Copy } from "../builder/types.js";

/**
 * E-commerce Specialist — only spawned at runtime when the CEO classifies the brief
 * as commerce (§3.2, §3.3.3). Its post is what makes the Designer add a pricing block.
 */
export function ecomPricingBlock(brief: string, orderId?: string): NonNullable<Copy["pricing"]> {
  const b = brief.toLowerCase();
  const subscription = /\b(month|subscription|membership|recurring|per month|\/mo)\b/.test(b);
  const suffix = subscription ? "/mo" : "";

  const tiers = [
    { name: "Starter", price: `$19${suffix}`, blurb: "The essentials, ready to go today." },
    { name: "Standard", price: `$49${suffix}`, blurb: "Everything in Starter, plus priority support.", highlight: true },
    { name: "Pro", price: `$99${suffix}`, blurb: "For teams who need it all, with onboarding included." },
  ];

  logDecision({
    agent: "ecom",
    type: "pricing_block",
    orderId,
    bandDependency: "runtime_specialist",
    input: brief,
    output: tiers.map((t) => `${t.name} ${t.price}`),
  });
  return tiers;
}
