import { logDecision } from "../log.js";
import { renderVariant } from "./render.js";
import { PALETTES } from "./palettes.js";
import type { VariantSpec } from "./types.js";
import { readSpec, writeSpec } from "../deploy/sites.js";
import { getVm, writeSiteToVm } from "../superserve/vm.js";
import type { Order } from "../db.js";

interface Rule {
  re: RegExp;
  apply: (s: VariantSpec, m: RegExpMatchArray) => VariantSpec;
  says: (m: RegExpMatchArray) => string;
}

const ACCENTS: Record<string, string> = {
  blue: "#2b6cb0",
  green: "#1f7a5a",
  red: "#c62f2f",
  orange: "#e05a2b",
  purple: "#6b46c1",
  pink: "#c3308a",
  black: "#111418",
  teal: "#0f766e",
  yellow: "#b45309",
};

const RULES: Rule[] = [
  {
    re: /\b(darker|dark mode|go dark|black background)\b/i,
    apply: (s) => ({ ...s, palette: { ...PALETTES.ink } }),
    says: () => "switched it to a dark theme",
  },
  {
    re: /\b(lighter|light mode|brighter|white background)\b/i,
    apply: (s) => ({ ...s, palette: { ...PALETTES.paper } }),
    says: () => "switched it to a light theme",
  },
  {
    re: new RegExp(`\\b(?:make (?:it|the accent|the buttons?)\\s+)?(${Object.keys(ACCENTS).join("|")})\\b`, "i"),
    apply: (s, m) => ({ ...s, palette: { ...s.palette, accent: ACCENTS[m[1].toLowerCase()] } }),
    says: (m) => `made the accent ${m[1].toLowerCase()}`,
  },
  {
    re: /\bheadline (?:to|should be|say)\s*["“']?([^"”'\n]{4,90})["”']?/i,
    apply: (s, m) => ({ ...s, copy: { ...s.copy, headline: m[1].trim() } }),
    says: (m) => `changed the headline to "${m[1].trim()}"`,
  },
  {
    re: /\b(?:cta|button)\s*(?:to|should say|says?)\s*["“']?([^"”'\n]{2,30})["”']?/i,
    apply: (s, m) => ({ ...s, copy: { ...s.copy, cta: m[1].trim() } }),
    says: (m) => `changed the button to "${m[1].trim()}"`,
  },
  {
    re: /\b(serif|more editorial|classier|elegant)\b/i,
    apply: (s) => ({ ...s, font: "serif", layout: "editorial" }),
    says: () => "gave it a more editorial, serif look",
  },
  {
    re: /\b(split|side by side|two column|image on the right)\b/i,
    apply: (s) => ({ ...s, layout: "split" }),
    says: () => "moved it to a split hero layout",
  },
  {
    re: /\b(centered|center it|simpler|minimal)\b/i,
    apply: (s) => ({ ...s, layout: "centered" }),
    says: () => "centered the hero",
  },
  {
    re: /\bname (?:to|is)\s*["“']?([^"”'\n]{2,30})["”']?/i,
    apply: (s, m) => ({ ...s, copy: { ...s.copy, brand: m[1].trim() } }),
    says: (m) => `renamed it to ${m[1].trim()}`,
  },
];

export interface EditResult {
  html: string;
  vmId: string;
  summary: string;
}

/**
 * §4.8 revision. Resumes the customer's VM, mutates the stored spec, re-renders,
 * and writes the result back into their workspace.
 */
export async function applyEdit(order: Order, instruction: string): Promise<EditResult> {
  const spec = readSpec<VariantSpec>(order.slug!);
  if (!spec) throw new Error(`no spec stored for ${order.slug}`);

  const vm = await getVm(order); // resumes the same sandbox id
  const vmId = vm?.id ?? "local";

  let next = spec;
  const applied: string[] = [];
  for (const rule of RULES) {
    const m = instruction.match(rule.re);
    if (!m) continue;
    next = rule.apply(next, m);
    applied.push(rule.says(m));
  }

  if (!applied.length) {
    // Unrecognised instruction: nudge the palette rather than silently no-op.
    next = { ...next, palette: { ...next.palette, accent: PALETTES.slate.accent } };
    applied.push("freshened up the styling");
  }

  const html = renderVariant(next);
  writeSpec(order.slug!, next);
  await writeSiteToVm(vm, html, order.id);

  const summary = applied.join(" and ");
  logDecision({
    agent: "designer",
    type: "revision_applied",
    orderId: order.id,
    input: instruction,
    output: { vmId, summary },
  });

  return { html, vmId, summary };
}
