export type Complexity = "S" | "M" | "L";

export interface Copy {
  brand: string;
  headline: string;
  subhead: string;
  cta: string;
  features: { title: string; body: string }[];
  /** Only rendered when the brief is e-commerce (§3.2 E-com Specialist). */
  pricing?: { name: string; price: string; blurb: string; highlight?: boolean }[];
  footer: string;
}

export type LayoutName = "centered" | "split" | "editorial";

export interface Palette {
  name: string;
  bg: string;
  fg: string;
  muted: string;
  accent: string;
  accentFg: string;
  surface: string;
  border: string;
}

export interface VariantSpec {
  idx: number;
  label: string;
  /** The scrubbed brief, so the hero motif can suit the business. */
  brief?: string;
  layout: LayoutName;
  palette: Palette;
  font: string;
  copy: Copy;
}

export interface Brief {
  raw: string;
  scrubbed: string;
  isEcommerce: boolean;
  complexity: Complexity;
}
