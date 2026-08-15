import { randomUUID } from "node:crypto";
import { config, has } from "../config.js";
import { logDecision, logStudy } from "../log.js";
import {
  createOrder,
  getOrder,
  updateOrder,
  upsertVariant,
  variantsFor,
  recordEvent,
  saveStudy,
  type Order,
  type Variant,
} from "../db.js";
import * as band from "../band/client.js";
import * as linq from "../linq/client.js";
import { design } from "../agents/designer.js";
import { writeCopy, rewriteCta } from "../agents/copywriter.js";
import { checkCompliance, DECLINE_MESSAGE } from "../agents/compliance.js";
import { priceOrder, payMessage, type Pricing } from "../agents/sales.js";
import { scrubPII } from "../agents/pii.js";
import { renderVariant } from "../builder/render.js";
import type { Copy, VariantSpec } from "../builder/types.js";
import { slugify, writeVariant, publish, writeSpec, variantUrl } from "../deploy/sites.js";
import { runStudy, watchAndUpgrade } from "../terac/study.js";
import { runQa, markFixed } from "../replay/qa.js";
import { buildInVm, pauseVm } from "../superserve/vm.js";
import { ecomPricingBlock } from "../agents/ecom.js";

export type Status =
  | "intake"
  | "declined"
  | "designing"
  | "building"
  | "human_testing"
  | "qa"
  | "deploying"
  | "live"
  | "failed";

function setStatus(order: Order, status: Status, extra: Partial<Order> = {}) {
  updateOrder(order.id, { status, ...extra });
  recordEvent(order.id, "ceo", "status", { status });
}

/** §4.1 intake — everything up to and including the compliance gate. */
export async function intake(phone: string, brief: string, chatId?: string): Promise<Order | null> {
  const id = randomUUID();
  const slug = slugify(brief, id);
  const order = createOrder({ id, phone, brief, slug, chatId });

  logDecision({ agent: "ceo", type: "order_created", orderId: id, input: brief, output: { slug } });

  const liveChatId = (await linq.sendText(phone, "Got it — building your page now. Give me a few minutes.", chatId)) ?? chatId;
  if (liveChatId && liveChatId !== chatId) updateOrder(id, { chat_id: liveChatId });
  await linq.sendTyping(liveChatId, phone);

  const scrubbed = await scrubPII(brief, id);
  updateOrder(id, { brief_scrubbed: scrubbed });

  const thread = `order-${id.slice(0, 8)}`;
  updateOrder(id, { band_thread_id: thread });

  try {
    await band.post({
      thread,
      from: "ceo",
      mentions: ["designer", "copywriter", "compliance", "sales"],
      type: "brief",
      body: scrubbed,
      orderId: id,
    });
  } catch (err) {
    // Band kill-switch: no room, no company. CEO cannot proceed (§7.8).
    setStatus(order, "failed");
    logDecision({ agent: "ceo", type: "halted_no_band", orderId: id, output: String(err) });
    await linq.sendText(phone, "Our build system is offline right now — we'll pick this up shortly.", liveChatId);
    return null;
  }

  const verdict = checkCompliance(scrubbed, "", id);
  await band.post({
    thread,
    from: "compliance",
    mentions: ["ceo"],
    type: "verdict",
    body: verdict.verdict === "VETO" ? `VETO: ${verdict.reason}` : "APPROVE",
    data: verdict,
    orderId: id,
  });

  if (verdict.verdict === "VETO") {
    setStatus(order, "declined", { compliance: "VETO", compliance_reason: verdict.reason ?? null });
    await linq.sendText(phone, DECLINE_MESSAGE, liveChatId);
    logDecision({
      agent: "ceo",
      type: "declined",
      orderId: id,
      bandDependency: "compliance_veto",
      output: verdict.reason,
    });
    return null;
  }

  updateOrder(id, { compliance: "APPROVE" });
  return getOrder(id)!;
}

/** §4.2–4.7 — the rest of the pipeline for a fresh order. */
export async function buildAndShip(order: Order): Promise<void> {
  const id = order.id;
  const thread = order.band_thread_id!;
  const brief = order.brief_scrubbed ?? order.brief;
  const chatId = order.chat_id ?? undefined;

  try {
    setStatus(order, "designing");

    // Sales starts waiting BEFORE the designer speaks — a real block on a Band message.
    const pricingPromise = priceOrder(thread, id);

    const d = design(brief, id);
    updateOrder(id, { complexity: d.complexity });

    // §3.3.3 runtime specialist — only spawned for e-commerce briefs, and the
    // designer's layout changes because of what it posts.
    let pricingBlock: Copy["pricing"];
    if (d.isEcommerce) {
      await band.addParticipant("ecom", thread, id);
      pricingBlock = ecomPricingBlock(brief, id);
      await band.post({
        thread,
        from: "ecom",
        mentions: ["designer", "copywriter"],
        type: "pricing_block",
        body: `Add a 3-tier pricing block: ${pricingBlock.map((p) => p.name).join(", ")}`,
        data: pricingBlock,
        orderId: id,
      });
      logDecision({
        agent: "designer",
        type: "layout_revised",
        orderId: id,
        bandDependency: "runtime_specialist",
        input: "ecom pricing_block received",
        output: "pricing section added to all 3 layouts",
      });
    }

    await band.post({
      thread,
      from: "designer",
      mentions: ["sales", "copywriter", "ceo"],
      type: "complexity_estimate",
      body: `Complexity ${d.complexity}; layouts: ${d.layouts.map((l) => l.label).join(", ")}`,
      data: { complexity: d.complexity, isEcommerce: d.isEcommerce },
      orderId: id,
    });

    const pricing = await pricingPromise;
    updateOrder(id, { tier: pricing.tier, amount_cents: pricing.amountCents });

    // ---- build 3 variants ----
    setStatus(order, "building");
    const copies = await Promise.all([0, 1, 2].map((a) => writeCopy(brief, a, id)));
    const specs: VariantSpec[] = d.layouts.map((l, i) => ({
      idx: i,
      label: l.label,
      layout: l.layout,
      palette: l.palette,
      font: l.font,
      copy: { ...copies[i], pricing: pricingBlock },
    }));

    await band.post({
      thread,
      from: "copywriter",
      mentions: ["ceo", "designer"],
      type: "copy_ready",
      body: specs.map((s) => `${s.idx + 1}. ${s.copy.headline}`).join(" | "),
      orderId: id,
    });

    const built = await buildInVm(order, specs);
    updateOrder(id, { superserve_vm_id: built.vmId });

    const variants: Variant[] = specs.map((s) => {
      const v: Variant = {
        id: `${id}-v${s.idx}`,
        order_id: id,
        idx: s.idx,
        label: s.label,
        html_path: writeVariant(order.slug!, s.idx, built.html[s.idx]),
        preview_url: variantUrl(order.slug!, s.idx),
        terac_score: null,
        replay_status: null,
      };
      upsertVariant(v);
      return v;
    });

    // ---- human testing ----
    setStatus(order, "human_testing");
    const modelPick = variants[0];
    const study = await runStudy({ order, variants, modelPick });
    saveStudy({
      id: randomUUID(),
      orderId: id,
      teracStudyId: study.studyId,
      question: study.question,
      results: study.results,
      winnerVariantId: study.winner.id,
      modelPickVariantId: modelPick.id,
    });
    logStudy({
      orderId: id,
      studyId: study.studyId,
      source: study.source,
      modelPick: modelPick.idx,
      humanPick: study.winner.idx,
      overridden: study.winner.id !== modelPick.id,
      preference: study.preference,
    });
    for (const v of variants) upsertVariant({ ...v, terac_score: study.scores[v.idx] ?? null });

    await band.post({
      thread,
      from: "ceo",
      mentions: ["qa"],
      type: "winner",
      body: `Variant ${study.winner.idx + 1} wins (${study.source}, ${Math.round(study.preference * 100)}%)`,
      data: { winnerIdx: study.winner.idx },
      orderId: id,
    });

    // ---- QA loop (max 3), with the QA -> Copywriter handoff ----
    setStatus(order, "qa");
    let winnerSpec = specs[study.winner.idx];
    let html = built.html[study.winner.idx];
    let qaStatus = "CLEAN";
    let blockingBugs: string[] = [];

    for (let attempt = 1; attempt <= 3; attempt++) {
      publish(order.slug!, html); // QA needs a reachable URL
      const report = await runQa(order, `${config.baseUrl}/s/${order.slug}`, attempt, html);
      qaStatus = report.status;
      blockingBugs = report.bugs.filter((b) => b.severity === "high").map((b) => b.title);
      upsertVariant({ ...variants[study.winner.idx], replay_status: report.status });

      if (report.status === "CLEAN" || !report.bugs.length) break;

      await band.post({
        thread,
        from: "qa",
        mentions: report.ctaBroken ? ["copywriter"] : ["designer"],
        type: "bugs",
        body: report.bugs.map((b) => b.title).join("; "),
        data: report.bugs,
        orderId: id,
      });

      // §3.3.4 — a broken CTA is the copywriter's problem, not a silent HTML patch.
      if (report.ctaBroken) {
        winnerSpec = { ...winnerSpec, copy: await rewriteCta(winnerSpec.copy, report.bugs[0]?.title ?? "broken CTA", id) };
      }
      const next = renderVariant(winnerSpec);
      if (next === html) {
        // Nothing we can fix automatically — stop burning QA runs on it.
        logDecision({ agent: "qa", type: "qa_no_fix_available", orderId: id, output: report.bugs.map((b) => b.title) });
        break;
      }
      html = next;
      for (const bug of report.bugs) if (bug.id) await markFixed(bug.id, id);
    }

    // ---- deploy + notify ----
    const gate = canGoLive(id, blockingBugs, !!study.winner);
    if (!gate.ok) {
      setStatus(order, "failed");
      logDecision({ agent: "ceo", type: "ship_blocked", orderId: id, output: gate.reason });
      await linq.sendText(order.phone, "Hit a snag finishing your page — a rebuild is running now.", chatId);
      return;
    }

    setStatus(order, "deploying");
    writeSpec(order.slug!, winnerSpec); // source of truth for later revisions
    const url = publish(order.slug!, html);
    await pauseVm(built.vmId, id); // §5.5 pause between turns

    setStatus(order, "live", { deploy_url: url });
    await notify(order, pricing, url, study, qaStatus);

    // If humans hadn't voted yet, keep listening and upgrade the page if they disagree.
    if (study.source === "model" && study.studyId) {
      void watchAndUpgrade(getOrder(id)!, variants, modelPick, async (winner, preference, n) => {
        const upgraded = { ...specs[winner.idx], copy: specs[winner.idx].copy };
        const upgradedHtml = renderVariant(upgraded);
        writeSpec(order.slug!, upgraded);
        publish(order.slug!, upgradedHtml);
        await linq.sendText(
          order.phone,
          `We upgraded your page — ${Math.round(preference * 100)}% of ${n} testers preferred this version. Same link: ${url}`,
          chatId,
        );
        logDecision({ agent: "ceo", type: "page_upgraded_by_humans", orderId: id, output: { winner: winner.idx, preference } });
      });
    }
  } catch (err) {
    setStatus(order, "failed");
    logDecision({ agent: "ceo", type: "pipeline_error", orderId: id, output: String(err) });
    await linq.sendText(order.phone, "Something broke on our side building your page. We're on it.", chatId);
  }
}

/** CEO ships only when QA is clean, a winner exists, and compliance hasn't vetoed (§3.1). */
function canGoLive(orderId: string, blockingBugs: string[], hasWinner: boolean): { ok: boolean; reason?: string } {
  const order = getOrder(orderId);
  if (!order) return { ok: false, reason: "order missing" };
  if (order.compliance === "VETO") return { ok: false, reason: "compliance veto" };
  if (!hasWinner) return { ok: false, reason: "no winner from human testing" };
  // Cosmetic findings don't hold up a sale; a broken CTA or missing viewport does.
  if (blockingBugs.length) return { ok: false, reason: `unfixed QA bugs: ${blockingBugs.join("; ")}` };
  return { ok: true };
}

async function notify(
  order: Order,
  pricing: Pricing,
  url: string,
  study: { source: string; preference: number; winner: Variant },
  qaStatus: string,
) {
  const chatId = order.chat_id ?? undefined;
  const lines = [payMessage(pricing, url)];
  if (study.source === "terac") {
    lines.push(``, `${Math.round(study.preference * 100)}% of real testers preferred this version.`);
  }
  if (qaStatus === "CLEAN") lines.push(`QA-certified — automated tests pass.`);
  lines.push(``, `Want a change? Just text me, e.g. "make it darker".`);

  await linq.sendText(order.phone, lines.join("\n"), chatId);
  await band.post({
    thread: order.band_thread_id!,
    from: "ceo",
    mentions: [],
    type: "shipped",
    body: `${url} at ${pricing.label}`,
    orderId: order.id,
  });
}

/** §4.8 revise — resume the same VM, edit, redeploy. */
export async function revise(order: Order, instruction: string): Promise<void> {
  const chatId = order.chat_id ?? undefined;
  await linq.sendText(order.phone, "On it — updating your page now.", chatId);
  await linq.sendTyping(chatId, order.phone);

  logDecision({ agent: "ceo", type: "revision_requested", orderId: order.id, input: instruction });

  const { applyEdit } = await import("../builder/edit.js");
  let html: string, vmId: string, summary: string;
  try {
    ({ html, vmId, summary } = await applyEdit(order, instruction));
  } catch (err) {
    logDecision({ agent: "ceo", type: "revision_failed", orderId: order.id, output: String(err) });
    await linq.sendText(order.phone, "I couldn't find that page to edit — text me a fresh brief?", chatId);
    return;
  }

  const url = publish(order.slug!, html);
  await pauseVm(vmId, order.id);
  updateOrder(order.id, { deploy_url: url, status: "live" });

  await band.post({
    thread: order.band_thread_id!,
    from: "ceo",
    mentions: [],
    type: "revised",
    body: `${summary} → ${url}`,
    orderId: order.id,
  });
  await linq.sendText(order.phone, `Done — ${summary}. Refresh: ${url}`, chatId);
}
