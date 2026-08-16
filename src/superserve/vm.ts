import { has } from "../config.js";
import { logDecision } from "../log.js";
import { renderVariant } from "../builder/render.js";
import type { VariantSpec } from "../builder/types.js";
import { getOrder, updateOrder, type Order } from "../db.js";

interface SandboxLike {
  id: string;
  files: {
    write(path: string, content: string): Promise<unknown>;
    /** Returns bytes (Uint8Array), not a string — see decode() below. */
    read(path: string): Promise<unknown>;
    list?(path: string): Promise<unknown>;
  };
  commands: { run(cmd: string): Promise<{ output?: string; stdout?: string; exitCode: number }> };
  pause(): Promise<unknown>;
  getPreviewUrl?(port: number): string;
  publishPreviewPort?(port: number, opts?: { access?: string }): Promise<unknown>;
}

/**
 * `files.read` resolves to a Uint8Array, not a string — reading a file and using it
 * directly yields "[object Object]". Decode explicitly.
 */
function decode(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array) return Buffer.from(v).toString("utf8");
  if (v && typeof v === "object") {
    // The SDK can hand back a plain object of byte indices over JSON transports.
    const bytes = Object.values(v as Record<string, number>).filter((n) => typeof n === "number");
    if (bytes.length) return Buffer.from(bytes).toString("utf8");
  }
  return String(v ?? "");
}

async function sdk(): Promise<any | null> {
  if (!has.superserve()) return null;
  try {
    // Computed specifier: the SDK is an optional peer, so a missing package must be a
    // runtime fallback rather than a compile error.
    const pkg = process.env.SUPERSERVE_SDK ?? "@superserve/sdk";
    const mod: any = await import(/* @vite-ignore */ pkg);
    return mod.Sandbox ?? mod.default?.Sandbox ?? null;
  } catch {
    logDecision({ agent: "system", type: "superserve_sdk_missing", output: "falling back to local build" });
    return null;
  }
}

/**
 * One persistent VM per order (§5.5): created on first build, resumed by id on every
 * revision, paused in between. The VM holds the customer's working directory — their
 * site files live there across turns, which is what makes resume meaningful.
 */
export async function getVm(order: Order): Promise<SandboxLike | null> {
  const Sandbox = await sdk();
  if (!Sandbox) return null;

  const existing = getOrder(order.id)?.superserve_vm_id;
  try {
    if (existing && existing !== "local") {
      const sb = await Sandbox.connect(existing); // auto-resumes if paused
      logDecision({ agent: "system", type: "vm_resumed", orderId: order.id, output: existing });
      return sb;
    }
    const sb = await Sandbox.create({
      name: `landline-${order.slug ?? order.id.slice(0, 8)}`,
      timeoutSeconds: 900,
      metadata: { orderId: order.id, product: "landline" },
    });
    updateOrder(order.id, { superserve_vm_id: sb.id });
    logDecision({ agent: "system", type: "vm_created", orderId: order.id, output: sb.id });
    return sb;
  } catch (err) {
    logDecision({ agent: "system", type: "vm_error", orderId: order.id, output: String(err) });
    return null;
  }
}

export interface BuildResult {
  vmId: string;
  html: string[];
}

/**
 * Renders the three variants and lands them in the customer's own sandbox workspace
 * at /site. Rendering is pure and deterministic, so a missing VM degrades to a local
 * build with byte-identical output.
 */
export async function buildInVm(order: Order, specs: VariantSpec[]): Promise<BuildResult> {
  const html = specs.map(renderVariant);
  const vm = await getVm(order);

  if (!vm) {
    logDecision({ agent: "designer", type: "build_local", orderId: order.id, output: `${html.length} variants` });
    return { vmId: "local", html };
  }

  try {
    await vm.commands.run("mkdir -p /site");
    await Promise.all(specs.map((s, i) => vm.files.write(`/site/v${i}.html`, html[i])));
    await vm.files.write("/site/brief.txt", order.brief_scrubbed ?? order.brief);
    logDecision({
      agent: "designer",
      type: "build_in_vm",
      orderId: order.id,
      output: { vm: vm.id, files: specs.map((s) => `v${s.idx}.html`) },
    });
  } catch (err) {
    logDecision({ agent: "system", type: "vm_write_failed", orderId: order.id, output: String(err) });
  }

  return { vmId: vm.id, html };
}

/** Reads the live page back out of the customer's VM so revisions edit their real file. */
export async function readSiteFromVm(order: Order): Promise<{ vm: SandboxLike | null; html: string | null }> {
  const vm = await getVm(order);
  if (!vm) return { vm: null, html: null };
  try {
    return { vm, html: decode(await vm.files.read("/site/index.html")) };
  } catch {
    return { vm, html: null };
  }
}

export async function writeSiteToVm(vm: SandboxLike | null, html: string, orderId?: string) {
  if (!vm) return;
  try {
    await vm.commands.run("mkdir -p /site");
    await vm.files.write("/site/index.html", html);
  } catch (err) {
    logDecision({ agent: "system", type: "vm_write_failed", orderId, output: String(err) });
  }
}

export async function pauseVm(vmId: string, orderId?: string) {
  if (!vmId || vmId === "local") return;
  const Sandbox = await sdk();
  if (!Sandbox) return;
  try {
    const sb = await Sandbox.connect(vmId);
    await sb.pause();
    logDecision({ agent: "system", type: "vm_paused", orderId, output: vmId });
  } catch (err) {
    logDecision({ agent: "system", type: "vm_pause_failed", orderId, output: String(err) });
  }
}
