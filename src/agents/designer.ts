import type { Complexity, LayoutName, Palette } from "../builder/types.js";
import { paletteTrio } from "../builder/palettes.js";
import { logDecision } from "../log.js";

export interface LayoutSpec {
  idx: number;
  label: string;
  layout: LayoutName;
  palette: Palette;
  font: "grotesk" | "serif";
}

export interface DesignerOutput {
  complexity: Complexity;
  isEcommerce: boolean;
  layouts: LayoutSpec[];
}

const ECOM = /\b(sell|shop|store|product|buy|order|checkout|merch|ecommerce|e-commerce|pricing|subscription|plans?)\b/i;

/**
 * Designer agent (§3.2). Sales blocks on this landing in the Band thread — see
 * agents/sales.ts and the `sales_blocks_on_designer` dependency.
 */
export function design(brief: string, orderId?: string): DesignerOutput {
  const words = brief.trim().split(/\s+/).length;
  const isEcommerce = ECOM.test(brief);
  const complexity: Complexity = words > 60 || isEcommerce ? "L" : words > 22 ? "M" : "S";

  const [p1, p2, p3] = paletteTrio(brief);
  const layouts: LayoutSpec[] = [
    { idx: 0, label: "Centered / bold", layout: "centered", palette: p1, font: "grotesk" },
    { idx: 1, label: "Split hero", layout: "split", palette: p2, font: "grotesk" },
    { idx: 2, label: "Editorial", layout: "editorial", palette: p3, font: "serif" },
  ];

  logDecision({
    agent: "designer",
    type: "complexity_estimate",
    orderId,
    input: brief,
    output: { complexity, isEcommerce, layouts: layouts.map((l) => l.label) },
  });

  return { complexity, isEcommerce, layouts };
}
