/**
 * Captures README screenshots from the live deployment.
 *   npx tsx scripts/screenshots.ts [baseUrl]
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const BASE = process.argv[2] ?? "https://landline-api-g4bp.onrender.com";
const OUT = resolve(process.cwd(), "docs/screenshots");
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();

async function shot(name: string, path: string, opts: { width?: number; height?: number; full?: boolean } = {}) {
  const page = await browser.newPage({
    viewport: { width: opts.width ?? 1280, height: opts.height ?? 860 },
    deviceScaleFactor: 2,
  });
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle", timeout: 90_000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: resolve(OUT, `${name}.png`), fullPage: opts.full ?? false });
  await page.close();
  console.log(`  ${name}.png  ←  ${path}`);
}

// Discover a live slug and study id from the storefront rather than hardcoding.
const probe = await browser.newPage();
await probe.goto(BASE, { waitUntil: "networkidle", timeout: 90_000 });
const html = await probe.content();
await probe.close();

const slug = html.match(/href="\/s\/([a-z0-9-]+)"/)?.[1];
const study = html.match(/\/study\/([0-9a-f-]{36})/)?.[1];
if (!slug || !study) throw new Error("storefront has no sites — run `npm run seed-demo` first");

await shot("storefront", "/", { full: true });
await shot("generated-site", `/s/${slug}`, { full: true });
await shot("generated-site-variant", `/s/${slug}/v2`);
await shot("generated-site-mobile", `/s/${slug}`, { width: 420, height: 860, full: true });
await shot("study-page", `/study/${study}`, { full: true });

await browser.close();
console.log("done");
