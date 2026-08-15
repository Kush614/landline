import { randomUUID } from "node:crypto";
import { logDecision } from "../log.js";
import { createOrder, getOrder, updateOrder, recordEvent, type Order } from "../db.js";
import * as band from "../band/client.js";
import * as linq from "../linq/client.js";
import { checkCompliance, DECLINE_MESSAGE } from "../agents/compliance.js";
import { scrubPII } from "../agents/pii.js";
import { slugify, publish } from "../deploy/sites.js";
import { pauseVm } from "../superserve/vm.js";
import { STEPS, STEP_FNS } from "./steps.js";

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

/**
 * §4.2–4.7 for a fresh order. Runs the same steps the Render Workflow runs, in
 * process. `RENDER_WORKFLOW_ENABLED=true` hands orchestration to Render instead.
 */
export async function buildAndShip(order: Order): Promise<void> {
  if (process.env.RENDER_WORKFLOW_ENABLED === "true") {
    const { triggerOrderWorkflow } = await import("./trigger.js");
    const handed = await triggerOrderWorkflow(order.id);
    if (handed) return;
    logDecision({ agent: "ceo", type: "workflow_fallback", orderId: order.id, output: "running in-process" });
  }

  for (const step of STEPS) {
    try {
      const out = await STEP_FNS[step](order.id);
      logDecision({ agent: "ceo", type: `step:${step}`, orderId: order.id, output: out });
    } catch (err) {
      setStatus(getOrder(order.id)!, "failed");
      logDecision({ agent: "ceo", type: `step_failed:${step}`, orderId: order.id, output: String(err) });
      await linq.sendText(
        order.phone,
        "Hit a snag finishing your page — a rebuild is running now.",
        order.chat_id ?? undefined,
      );
      return;
    }
  }
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
