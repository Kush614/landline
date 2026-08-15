import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.js";
import { logDecision } from "../log.js";
import { getVm } from "../superserve/vm.js";
import type { Order } from "../db.js";

const SITES_DIR = process.env.SITES_DIR ?? resolve(process.cwd(), "sites");
const WIDTH = Number(process.env.SHOT_WIDTH ?? 1200);
const HEIGHT = Number(process.env.SHOT_HEIGHT ?? 900);

export type ShotSource = "vm" | "playwright" | "none";

export interface Shot {
  idx: number;
  path: string | null;
  url: string | null;
  source: ShotSource;
}

const shotPath = (slug: string, idx: number) => resolve(SITES_DIR, slug, `v${idx}.png`);
export const shotUrl = (slug: string, idx: number) => `${config.baseUrl}/s/${slug}/v${idx}.png`;
export const shotExists = (slug: string, idx: number) => existsSync(shotPath(slug, idx));

/** Chromium's headless screenshot flag — same invocation in the VM and locally. */
const chromeArgs = (htmlPath: string, outPath: string) =>
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    `--window-size=${WIDTH},${HEIGHT}`,
    `--screenshot=${outPath}`,
    `file://${htmlPath}`,
  ].join(" ");

/**
 * Screenshot inside the customer's own Superserve VM. This is our second, distinct
 * Superserve use — the VM is not just a build box, it renders the previews too, so
 * the customer's artifacts never leave their sandbox until we pull the PNG out.
 *
 * Binary comes back base64-encoded because the SDK's files.read() returns a string.
 */
async function captureInVm(order: Order, indices: number[]): Promise<Map<number, Buffer>> {
  const out = new Map<number, Buffer>();
  const vm = await getVm(order);
  if (!vm) return out;

  try {
    const probe = await vm.commands.run(
      "command -v chromium || command -v chromium-browser || command -v google-chrome || command -v google-chrome-stable || true",
    );
    const chrome = (probe.output ?? probe.stdout ?? "").trim().split("\n")[0];
    if (!chrome) {
      logDecision({ agent: "system", type: "shot_vm_no_chromium", orderId: order.id });
      return out;
    }

    for (const idx of indices) {
      const html = `/site/v${idx}.html`;
      const png = `/site/v${idx}.png`;
      const res = await vm.commands.run(`${chrome} ${chromeArgs(html, png)} 2>/dev/null; base64 -w0 ${png} 2>/dev/null || base64 -i ${png}`);
      const b64 = (res.output ?? res.stdout ?? "").trim();
      if (res.exitCode === 0 && b64.length > 100) {
        out.set(idx, Buffer.from(b64, "base64"));
      }
    }
    logDecision({
      agent: "system",
      type: "shots_captured_in_vm",
      orderId: order.id,
      output: { vm: vm.id, captured: [...out.keys()] },
    });
  } catch (err) {
    logDecision({ agent: "system", type: "shot_vm_failed", orderId: order.id, output: String(err) });
  }
  return out;
}

/** Local Playwright — works today, before any Superserve key exists. */
async function captureLocally(htmlByIdx: Map<number, string>, orderId?: string): Promise<Map<number, Buffer>> {
  const out = new Map<number, Buffer>();
  let browser: { newPage: () => Promise<any>; close: () => Promise<void> } | undefined;

  try {
    const pkg = process.env.PLAYWRIGHT_PKG ?? "playwright";
    const { chromium }: any = await import(/* @vite-ignore */ pkg);
    browser = await chromium.launch({ args: ["--no-sandbox"] });

    for (const [idx, html] of htmlByIdx) {
      const page = await browser!.newPage();
      await page.setViewportSize({ width: WIDTH, height: HEIGHT });
      await page.setContent(html, { waitUntil: "load" });
      out.set(idx, await page.screenshot({ type: "png" }));
      await page.close();
    }
    logDecision({ agent: "system", type: "shots_captured_locally", orderId, output: [...out.keys()] });
  } catch (err) {
    logDecision({ agent: "system", type: "shot_local_failed", orderId, output: String(err) });
  } finally {
    await browser?.close().catch(() => {});
  }
  return out;
}

/**
 * Screenshots for every variant. VM first (it's the customer's sandbox and it's a
 * second Superserve use to point at), local Playwright otherwise. Pages are
 * self-contained single files with inlined CSS, so both render identically.
 *
 * Never throws: a missing screenshot degrades the study page to a live iframe and
 * the iMessage reply to text-only.
 */
export async function captureVariants(
  order: Order,
  htmlByIdx: Map<number, string>,
): Promise<Shot[]> {
  const indices = [...htmlByIdx.keys()].sort((a, b) => a - b);
  const slug = order.slug!;
  mkdirSync(resolve(SITES_DIR, slug), { recursive: true });

  let source: ShotSource = "none";
  let buffers = new Map<number, Buffer>();

  if (process.env.SHOTS_ENABLED !== "false") {
    buffers = await captureInVm(order, indices);
    if (buffers.size) source = "vm";

    if (buffers.size < indices.length) {
      const missing = new Map([...htmlByIdx].filter(([i]) => !buffers.has(i)));
      const local = await captureLocally(missing, order.id);
      for (const [i, b] of local) buffers.set(i, b);
      if (local.size) source = buffers.size === local.size ? "playwright" : source;
    }
  }

  return indices.map((idx) => {
    const buf = buffers.get(idx);
    if (!buf) return { idx, path: null, url: null, source: "none" as const };
    const path = shotPath(slug, idx);
    writeFileSync(path, buf);
    return { idx, path, url: shotUrl(slug, idx), source };
  });
}
