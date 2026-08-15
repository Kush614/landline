import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const LOG_DIR = resolve(process.cwd(), "logs");
mkdirSync(LOG_DIR, { recursive: true });

export type Agent =
  | "ceo"
  | "designer"
  | "copywriter"
  | "qa"
  | "sales"
  | "compliance"
  | "ecom"
  | "system";

export interface Decision {
  agent: Agent;
  type: string;
  orderId?: string;
  input?: unknown;
  output?: unknown;
  /** Set for the four Band dependencies in §3.3 so we can prove them to judges. */
  bandDependency?: "sales_blocks_on_designer" | "compliance_veto" | "runtime_specialist" | "qa_changes_copywriter";
}

function append(file: string, row: object) {
  try {
    appendFileSync(resolve(LOG_DIR, file), JSON.stringify({ ts: new Date().toISOString(), ...row }) + "\n");
  } catch {
    // Logging must never take down a customer flow.
  }
}

const truncate = (v: unknown) => {
  if (v === undefined) return undefined;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 600 ? s.slice(0, 600) + "…" : s;
};

export function logDecision(d: Decision) {
  const row = { ...d, input: truncate(d.input), output: truncate(d.output) };
  append("decisions.jsonl", row);
  console.log(`[${d.agent}] ${d.type}${d.orderId ? ` order=${d.orderId}` : ""} ${truncate(d.output) ?? ""}`);
}

export const logStudy = (row: object) => append("studies.jsonl", row);
export const logRevenue = (row: object) => append("revenue.jsonl", row);
