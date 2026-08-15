import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.js";
import { logDecision } from "../log.js";

const SITES_DIR = process.env.SITES_DIR ?? resolve(process.cwd(), "sites");
mkdirSync(SITES_DIR, { recursive: true });

const dir = (slug: string) => resolve(SITES_DIR, slug);

export function slugify(brief: string, id: string): string {
  const base = brief
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .split(/\s+/)
    .filter((w) => !["a", "an", "the", "for", "with", "and", "page", "site", "landing", "my"].includes(w))
    .slice(0, 3)
    .join("-")
    .slice(0, 28);
  return `${base || "site"}-${id.slice(-4)}`;
}

/** Idempotent: writing the same slug twice just replaces the file (§4 "re-run safe"). */
export function writeVariant(slug: string, idx: number, html: string): string {
  mkdirSync(dir(slug), { recursive: true });
  const path = resolve(dir(slug), `v${idx}.html`);
  writeFileSync(path, html, "utf8");
  return path;
}

export function publish(slug: string, html: string): string {
  mkdirSync(dir(slug), { recursive: true });
  writeFileSync(resolve(dir(slug), "index.html"), html, "utf8");
  const url = `${config.baseUrl}/s/${slug}`;
  logDecision({ agent: "system", type: "published", input: slug, output: url });
  return url;
}

/**
 * All three specs, persisted so a later pipeline step running in a different Render
 * task instance can pick up where the previous one left off.
 */
export function writeSpecs(slug: string, specs: unknown[]) {
  mkdirSync(dir(slug), { recursive: true });
  writeFileSync(resolve(dir(slug), "specs.json"), JSON.stringify(specs), "utf8");
}

export function readSpecs<T>(slug: string): T[] | null {
  const path = resolve(dir(slug), "specs.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T[];
  } catch {
    return null;
  }
}

/** The winning spec is the source of truth for revisions — we re-render, never string-munge. */
export function writeSpec(slug: string, spec: unknown) {
  mkdirSync(dir(slug), { recursive: true });
  writeFileSync(resolve(dir(slug), "spec.json"), JSON.stringify(spec, null, 2), "utf8");
}

export function readSpec<T>(slug: string): T | null {
  const path = resolve(dir(slug), "spec.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function readSite(slug: string, file = "index.html"): string | null {
  const path = resolve(dir(slug), file);
  if (!path.startsWith(SITES_DIR) || !existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

export const variantUrl = (slug: string, idx: number) => `${config.baseUrl}/s/${slug}/v${idx}`;
export const siteUrl = (slug: string) => `${config.baseUrl}/s/${slug}`;
