import { logDecision } from "../log.js";

export interface ComplianceVerdict {
  verdict: "APPROVE" | "VETO";
  reason?: string;
}

/**
 * Rules first, because a hackathon demo needs a deterministic veto (§7.9:
 * "supplement that cures anxiety" must reliably decline).
 */
const RULES: { re: RegExp; reason: string }[] = [
  {
    re: /\b(cures?|curing|treats?|heals?|reverses?)\b[^.]{0,40}\b(anxiety|depression|cancer|diabetes|autism|covid|adhd|alzheimer'?s?)\b/i,
    reason: "medical claim",
  },
  {
    re: /\b(supplement|tincture|peptide|nootropic|herbal remedy)\b[^.]{0,60}\b(cure|cures|treat|treats|heal|heals|fda)\b/i,
    reason: "unapproved health product claim",
  },
  { re: /\b(guaranteed|risk[- ]free)\b[^.]{0,30}\b(returns?|profits?|income|roi)\b/i, reason: "financial guarantee" },
  { re: /\b(get rich quick|double your money|guaranteed \d+%)\b/i, reason: "financial guarantee" },
  { re: /\b(counterfeit|replica watches|fake ids?|forged documents?)\b/i, reason: "counterfeit goods" },
  { re: /\b(escort service|onlyfans management|adult content)\b/i, reason: "adult content" },
  { re: /\b(buy|sell|order)\b[^.]{0,25}\b(cocaine|heroin|meth|mdma|fentanyl|steroids|xanax)\b/i, reason: "controlled substances" },
  { re: /\b(payday loans?|debt elimination|credit repair guaranteed)\b/i, reason: "regulated financial service" },
  { re: /\b(weapons?|firearms?|ammunition|silencers?|ghost guns?)\s+(for sale|shop|store)/i, reason: "weapons sales" },
];

/** Compliance agent (§3.2). Any deploy step must read this verdict first (§3.3.2). */
export function checkCompliance(brief: string, copy = "", orderId?: string): ComplianceVerdict {
  const text = `${brief}\n${copy}`;
  for (const rule of RULES) {
    if (rule.re.test(text)) {
      const verdict: ComplianceVerdict = {
        verdict: "VETO",
        reason: rule.reason,
      };
      logDecision({
        agent: "compliance",
        type: "veto",
        orderId,
        bandDependency: "compliance_veto",
        input: brief,
        output: verdict,
      });
      return verdict;
    }
  }
  logDecision({ agent: "compliance", type: "approve", orderId, input: brief, output: "APPROVE" });
  return { verdict: "APPROVE" };
}

export const DECLINE_MESSAGE =
  "Thanks for the brief — we can't take this one on. We don't build pages that make health, medical, or guaranteed-earnings claims, since they'd get the site (and you) in trouble with ad platforms and regulators. Happy to build something for you with a different angle.";
