import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { logDecision, logStudy } from "../log.js";
import { getOrder, updateOrder, upsertVariant, variantsFor, recordEvent, saveStudy, latestStudy, type Order } from "../db.js";
import * as band from "../band/client.js";
import * as linq from "../linq/client.js";
import { design } from "../agents/designer.js";
import { writeCopy, rewriteCta } from "../agents/copywriter.js";
import { priceOrder, payMessage, TIERS, type Pricing } from "../agents/sales.js";
import { renderVariant } from "../builder/render.js";
import type { Copy, VariantSpec } from "../builder/types.js";
import { writeVariant, publish, writeSpec, writeSpecs, readSpecs, variantUrl } from "../deploy/sites.js";
import { runStudy, watchAndUpgrade } from "../terac/study.js";
import { runQa, markFixed } from "../replay/qa.js";
import { buildInVm, pauseVm } from "../superserve/vm.js";
import { ecomPricingBlock } from "../agents/ecom.js";

/**
 * The §4 pipeline as discrete, re-runnable steps. Each one loads what it needs from
 * SQLite and the persisted specs, so a step can run in a fresh Render task instance
 * that shares no memory with the step before it. `buildAndShip` runs them in-process;
 * the Render Workflow runs the same steps through HTTP.
 */

export type StepName = "design_copy" | "build" | "human_test" | "qa" | "deploy" | "notify";
export const STEPS: StepName[] = ["design_copy", "build", "human_test", "qa", "deploy", "notify"];

export class StepError extends Error {}

function load(orderId: string): Order {
  const o = getOrder(orderId);
  if (!o) throw new StepError(`order ${orderId} not found`);
  if (!o.slug) throw new StepError(`order ${orderId} has no slug`);
  if (!o.band_thread_id) throw new StepError(`order ${orderId} has no Band thread`);
  return o;
}

const setStatus = (id: string, status: string, extra: Record<string, unknown> = {}) => {
  updateOrder(id, { status, ...extra } as never);
  recordEvent(id, "ceo", "status", { status });
};

const pricingFor = (order: Order): Pricing =>
  Object.values(TIERS).find((t) => t.tier === order.tier) ?? TIERS.S;

// ------------------------------------------------------------------ design_copy
export async function stepDesignCopy(orderId: string) {
  const order = load(orderId);
  const brief = order.brief_scrubbed ?? order.brief;
  const thread = order.band_thread_id!;
  setStatus(orderId, "designing");

  // Sales starts waiting BEFORE the designer speaks — a real block on a Band message.
  const pricingPromise = priceOrder(thread, orderId);

  const d = design(brief, orderId);
  updateOrder(orderId, { complexity: d.complexity });

  // §3.3.3 runtime specialist — its post is what changes the Designer's layouts.
  let pricingBlock: Copy["pricing"];
  if (d.isEcommerce) {
    await band.addParticipant("ecom", thread, orderId);
    pricingBlock = ecomPricingBlock(brief, orderId);
    await band.post({
      thread, from: "ecom", mentions: ["designer", "copywriter"], type: "pricing_block",
      body: `Add a 3-tier pricing block: ${pricingBlock.map((p) => p.name).join(", ")}`,
      data: pricingBlock, orderId,
    });
    logDecision({
      agent: "designer", type: "layout_revised", orderId,
      bandDependency: "runtime_specialist",
      input: "ecom pricing_block received",
      output: "pricing section added to all 3 layouts",
    });
  }

  await band.post({
    thread, from: "designer", mentions: ["sales", "copywriter", "ceo"], type: "complexity_estimate",
    body: `Complexity ${d.complexity}; layouts: ${d.layouts.map((l) => l.label).join(", ")}`,
    data: { complexity: d.complexity, isEcommerce: d.isEcommerce }, orderId,
  });

  const pricing = await pricingPromise;
  updateOrder(orderId, { tier: pricing.tier, amount_cents: pricing.amountCents });

  const copies = await Promise.all([0, 1, 2].map((a) => writeCopy(brief, a, orderId)));
  const specs: VariantSpec[] = d.layouts.map((l, i) => ({
    idx: i, label: l.label, layout: l.layout, palette: l.palette, font: l.font,
    copy: { ...copies[i], pricing: pricingBlock },
  }));
  writeSpecs(order.slug!, specs);

  await band.post({
    thread, from: "copywriter", mentions: ["ceo", "designer"], type: "copy_ready",
    body: specs.map((s) => `${s.idx + 1}. ${s.copy.headline}`).join(" | "), orderId,
  });

  return { complexity: d.complexity, tier: pricing.tier, headlines: specs.map((s) => s.copy.headline) };
}

// ------------------------------------------------------------------------ build
export async function stepBuild(orderId: string) {
  const order = load(orderId);
  const specs = readSpecs<VariantSpec>(order.slug!);
  if (!specs) throw new StepError("no specs — run design_copy first");
  setStatus(orderId, "building");

  const built = await buildInVm(order, specs);
  updateOrder(orderId, { superserve_vm_id: built.vmId });

  for (const s of specs) {
    upsertVariant({
      id: `${orderId}-v${s.idx}`, order_id: orderId, idx: s.idx, label: s.label,
      html_path: writeVariant(order.slug!, s.idx, built.html[s.idx]),
      preview_url: variantUrl(order.slug!, s.idx),
      terac_score: null, replay_status: null,
    });
  }
  return { vmId: built.vmId, variants: specs.length };
}

// ------------------------------------------------------------------- human_test
export async function stepHumanTest(orderId: string) {
  const order = load(orderId);
  const variants = variantsFor(orderId);
  if (!variants.length) throw new StepError("no variants — run build first");
  setStatus(orderId, "human_testing");

  const modelPick = variants[0];
  const study = await runStudy({ order, variants, modelPick });

  saveStudy({
    id: randomUUID(), orderId, teracStudyId: study.studyId, question: study.question,
    results: study.results, winnerVariantId: study.winner.id, modelPickVariantId: modelPick.id,
  });
  logStudy({
    orderId, studyId: study.studyId, source: study.source,
    modelPick: modelPick.idx, humanPick: study.winner.idx,
    overridden: study.winner.id !== modelPick.id, preference: study.preference,
  });
  for (const v of variants) upsertVariant({ ...v, terac_score: study.scores[v.idx] ?? null });
  updateOrder(orderId, { winner_idx: study.winner.idx });

  await band.post({
    thread: order.band_thread_id!, from: "ceo", mentions: ["qa"], type: "winner",
    body: `Variant ${study.winner.idx + 1} wins (${study.source}, ${Math.round(study.preference * 100)}%)`,
    data: { winnerIdx: study.winner.idx }, orderId,
  });

  return { winnerIdx: study.winner.idx, source: study.source, preference: study.preference, studyId: study.studyId };
}

// --------------------------------------------------------------------------- qa
export async function stepQa(orderId: string) {
  const order = load(orderId);
  const specs = readSpecs<VariantSpec>(order.slug!);
  if (!specs) throw new StepError("no specs — run design_copy first");
  const winnerIdx = order.winner_idx ?? 0;
  const variants = variantsFor(orderId);
  setStatus(orderId, "qa");

  let winnerSpec = specs[winnerIdx];
  let html = renderVariant(winnerSpec);
  let qaStatus = "CLEAN";
  let blockingBugs: string[] = [];

  for (let attempt = 1; attempt <= 3; attempt++) {
    publish(order.slug!, html); // QA needs a reachable URL
    const report = await runQa(order, `${config.baseUrl}/s/${order.slug}`, attempt, html);
    qaStatus = report.status;
    blockingBugs = report.bugs.filter((b) => b.severity === "high").map((b) => b.title);
    if (variants[winnerIdx]) upsertVariant({ ...variants[winnerIdx], replay_status: report.status });

    if (report.status === "CLEAN" || !report.bugs.length) break;

    await band.post({
      thread: order.band_thread_id!, from: "qa",
      mentions: report.ctaBroken ? ["copywriter"] : ["designer"], type: "bugs",
      body: report.bugs.map((b) => b.title).join("; "), data: report.bugs, orderId,
    });

    // §3.3.4 — a broken CTA is the copywriter's problem, not a silent HTML patch.
    if (report.ctaBroken) {
      winnerSpec = { ...winnerSpec, copy: await rewriteCta(winnerSpec.copy, report.bugs[0]?.title ?? "broken CTA", orderId) };
    }
    const next = renderVariant(winnerSpec);
    if (next === html) {
      logDecision({ agent: "qa", type: "qa_no_fix_available", orderId, output: blockingBugs });
      break;
    }
    html = next;
    for (const bug of report.bugs) if (bug.id) await markFixed(bug.id, orderId);
  }

  specs[winnerIdx] = winnerSpec;
  writeSpecs(order.slug!, specs);
  writeSpec(order.slug!, winnerSpec); // source of truth for revisions
  updateOrder(orderId, { qa_status: qaStatus });

  return { status: qaStatus, blockingBugs };
}

// ----------------------------------------------------------------------- deploy
export async function stepDeploy(orderId: string) {
  const order = load(orderId);
  const specs = readSpecs<VariantSpec>(order.slug!);
  if (!specs) throw new StepError("no specs — run design_copy first");

  const gate = canGoLive(order, order.qa_status === "BUGS");
  if (!gate.ok) {
    setStatus(orderId, "failed");
    logDecision({ agent: "ceo", type: "ship_blocked", orderId, output: gate.reason });
    throw new StepError(`refusing to ship: ${gate.reason}`);
  }

  setStatus(orderId, "deploying");
  const url = publish(order.slug!, renderVariant(specs[order.winner_idx ?? 0]));
  if (order.superserve_vm_id) await pauseVm(order.superserve_vm_id, orderId); // §5.5
  setStatus(orderId, "live", { deploy_url: url });
  return { url };
}

/** CEO ships only when QA is clean, a winner exists, and compliance hasn't vetoed (§3.1). */
function canGoLive(order: Order, hasBlockingBugs: boolean): { ok: boolean; reason?: string } {
  if (order.compliance === "VETO") return { ok: false, reason: "compliance veto" };
  if (order.winner_idx === null || order.winner_idx === undefined)
    return { ok: false, reason: "no winner from human testing" };
  if (hasBlockingBugs) return { ok: false, reason: `unfixed QA bugs (${order.qa_status})` };
  return { ok: true };
}

// ----------------------------------------------------------------------- notify
export async function stepNotify(orderId: string) {
  const order = load(orderId);
  if (!order.deploy_url) throw new StepError("nothing deployed yet");

  const pricing = pricingFor(order);
  const study = latestStudySummary(orderId);
  const lines = [payMessage(pricing, order.deploy_url)];
  if (study?.source === "terac") {
    lines.push(``, `${Math.round((study.preference ?? 0) * 100)}% of real testers preferred this version.`);
  }
  if (order.qa_status === "CLEAN") lines.push(`QA-certified — automated tests pass.`);
  lines.push(``, `Want a change? Just text me, e.g. "make it darker".`);

  await linq.sendText(order.phone, lines.join("\n"), order.chat_id ?? undefined);
  await band.post({
    thread: order.band_thread_id!, from: "ceo", mentions: [], type: "shipped",
    body: `${order.deploy_url} at ${pricing.label}`, orderId,
  });

  // If humans hadn't voted yet, keep listening and upgrade the page if they disagree.
  if (study?.source === "model" && study.studyId) {
    const variants = variantsFor(orderId);
    const specs = readSpecs<VariantSpec>(order.slug!);
    if (specs && variants.length) {
      void watchAndUpgrade(order, variants, variants[0], async (winner, preference, n) => {
        writeSpec(order.slug!, specs[winner.idx]);
        publish(order.slug!, renderVariant(specs[winner.idx]));
        updateOrder(orderId, { winner_idx: winner.idx });
        await linq.sendText(
          order.phone,
          `We upgraded your page — ${Math.round(preference * 100)}% of ${n} testers preferred this version. Same link: ${order.deploy_url}`,
          order.chat_id ?? undefined,
        );
        logDecision({ agent: "ceo", type: "page_upgraded_by_humans", orderId, output: { winner: winner.idx, preference } });
      });
    }
  }

  return { notified: order.phone, url: order.deploy_url };
}

/** Reads back what stepHumanTest recorded, since notify may run in a fresh instance. */
function latestStudySummary(orderId: string): { source: string; preference: number; studyId: string | null } | null {
  const row = latestStudy(orderId);
  if (!row) return null;
  let preference = 0;
  let n = 0;
  try {
    const parsed = JSON.parse(row.results_json ?? "{}");
    preference = parsed?.n ? (parsed.scores?.[row.winner_variant_id?.split("-v").pop() ?? "0"] ?? 0) / parsed.n : 0;
    n = parsed?.n ?? 0;
  } catch {
    /* results may be a plain note when we shipped the model pick */
  }
  return { source: n > 0 ? "terac" : "model", preference, studyId: row.terac_study_id };
}

export const STEP_FNS: Record<StepName, (orderId: string) => Promise<unknown>> = {
  design_copy: stepDesignCopy,
  build: stepBuild,
  human_test: stepHumanTest,
  qa: stepQa,
  deploy: stepDeploy,
  notify: stepNotify,
};
