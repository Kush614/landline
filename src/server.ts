import Fastify from "fastify";
import formbody from "@fastify/formbody";
import { config, has } from "./config.js";
import { logDecision } from "./log.js";
import {
  getOrder,
  latestOrderForPhone,
  recordVote,
  variantsFor,
  votesFor,
} from "./db.js";
import * as linq from "./linq/client.js";
import * as agentpay from "./linq/agentpay.js";
import { intake, buildAndShip, revise } from "./pipeline/run.js";
import { STEPS, STEP_FNS, type StepName } from "./pipeline/steps.js";
import { readSite } from "./deploy/sites.js";
import { studyPage, thanksPage } from "./terac/page.js";
import { dashboard } from "./dashboard/data.js";

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
  bodyLimit: 2 * 1024 * 1024,
});

await app.register(formbody);

// Keep the raw body so webhook signatures verify against the exact bytes sent.
app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
  (req as any).rawBody = body as string;
  try {
    done(null, body ? JSON.parse(body as string) : {});
  } catch (err) {
    done(err as Error, undefined);
  }
});

/**
 * Screenshot-friendly: every sponsor, whether it's running live or on its fallback,
 * and what the fallback actually does.
 */
const SPONSOR_FALLBACKS: Record<string, string> = {
  linq: "messages logged to decisions.jsonl instead of sent",
  stripe: "no payment link in the reply",
  terac: "ship the model's pick, no human vote",
  replay: "static markup checks only",
  superserve: "build locally, no per-order VM",
  pioneer: "deterministic template copy, regex PII scrub",
  band: "PIPELINE HALTS — this is the kill-switch",
  render: "pipeline runs in-process, no Workflow run history",
};

function sponsorReport() {
  const live: Record<string, boolean> = {
    linq: has.linq(), stripe: has.stripe(), terac: has.terac(), replay: has.replay(),
    superserve: has.superserve(), pioneer: has.pioneer(), band: has.band(), render: has.render(),
  };
  const rows = Object.entries(live).map(([name, isLive]) => ({
    sponsor: name,
    mode: isLive ? "LIVE" : "FALLBACK",
    fallback: isLive ? null : SPONSOR_FALLBACKS[name],
  }));
  return {
    live,
    rows,
    live_count: rows.filter((r) => r.mode === "LIVE").length,
    total: rows.length,
    summary: rows.map((r) => `${r.sponsor}=${r.mode}`).join(" "),
  };
}

app.get("/health", async () => {
  const s = sponsorReport();
  const { teracAlarms } = await import("./terac/study.js");
  return {
    ok: true,
    ts: new Date().toISOString(),
    terac_degraded: teracAlarms.length > 0,
    terac_last_alarm: teracAlarms.at(-1) ?? null,
    base_url: config.baseUrl,
    band_enabled: config.band.enabled,
    orchestration: process.env.RENDER_WORKFLOW_ENABLED === "true" ? "render-workflow" : "in-process",
    sponsors: s.live,
    sponsor_status: s.rows,
    sponsors_live: `${s.live_count}/${s.total}`,
    summary: s.summary,
  };
});

const REVISION_HINT = /\b(make|change|add|remove|swap|darker|lighter|bigger|smaller|update|instead|move|rename|headline|button|cta|color|colour)\b/i;

app.post("/webhooks/linq", async (request, reply) => {
  const raw = (request as any).rawBody ?? JSON.stringify(request.body ?? {});
  if (!linq.verifySignature(request.headers as Record<string, string>, raw)) {
    logDecision({ agent: "system", type: "webhook_rejected", output: "bad signature" });
    return reply.code(401).send({ error: "invalid signature" });
  }

  const msg = linq.parseInbound(request.body);
  if (!msg) return reply.code(202).send({ ignored: "unparseable" });

  // Acknowledge immediately — Linq retries slow webhooks, and builds take minutes.
  reply.code(202).send({ ok: true });

  void handleInbound(msg).catch((err) =>
    logDecision({ agent: "system", type: "inbound_error", output: String(err) }),
  );
});

async function handleInbound(msg: linq.InboundMessage) {
  const { phone, text, chatId } = msg;

  if (msg.isReaction) {
    // 👍 tapback = approval (§5.3).
    logDecision({ agent: "ceo", type: "tapback", input: phone, output: msg.reaction });
    const prior = latestOrderForPhone(phone);
    if (prior?.status === "live" && /👍|like|love|❤️/.test(msg.reaction ?? "")) {
      const pay = await agentpay.payInstruction({
        handle: phone,
        orderId: prior.id,
        amountCents: prior.amount_cents || 900,
        description: `LANDLINE — ${prior.slug}`,
        chatId: prior.chat_id ?? chatId,
      });
      await linq.sendText(phone, `Glad you like it. ${pay.text}`, prior.chat_id ?? chatId);
    }
    return;
  }

  if (!text) return;

  const prior = latestOrderForPhone(phone);

  // A bare 6-digit number is never a brief — it's an Agent Pay code, ours or a stray.
  // Handled before the revision and new-order branches so we never build a page
  // called "482913".
  if (agentpay.looksLikeCode(text)) {
    if (!agentpay.hasPendingConnect(phone)) {
      await linq.sendText(
        phone,
        prior
          ? "I wasn't expecting a code — text PAY if you want to set up Apple Pay, or describe a change to your page."
          : "That looks like a verification code, but I don't have anything pending for you. Text me a description of the page you want and I'll build it.",
        prior?.chat_id ?? chatId,
      );
      return;
    }
    const ok = await agentpay.verifyConnect(phone, text.trim(), prior?.id);
    if (!ok) {
      await linq.sendText(phone, "That code didn't work — text PAY and I'll send a fresh one.", prior?.chat_id ?? chatId);
      return;
    }
    if (prior?.deploy_url && prior.status === "live") {
      const pay = await agentpay.payInstruction({
        handle: phone,
        orderId: prior.id,
        amountCents: prior.amount_cents || 900,
        description: `LANDLINE — ${prior.slug}`,
        chatId: prior.chat_id ?? chatId,
      });
      await linq.sendText(phone, `Apple Pay is set up. ${pay.text}`, prior.chat_id ?? chatId);
    } else {
      await linq.sendText(phone, "Apple Pay is set up — I'll send the request when your page is ready.", prior?.chat_id ?? chatId);
    }
    return;
  }

  // Explicit re-request of a connect code.
  if (/^\s*pay\s*$/i.test(text) && prior) {
    const offer = await agentpay.offerConnect(phone, prior.id);
    const pay = offer
      ? offer
      : (await agentpay.payInstruction({
          handle: phone,
          orderId: prior.id,
          amountCents: prior.amount_cents || 900,
          description: `LANDLINE — ${prior.slug}`,
        })).text;
    await linq.sendText(phone, pay, prior.chat_id ?? chatId);
    return;
  }
  const isRevision =
    !!prior &&
    ["live", "failed"].includes(prior.status) &&
    text.split(/\s+/).length <= 25 &&
    REVISION_HINT.test(text);

  if (isRevision) {
    await revise(prior!, text);
    return;
  }

  const order = await intake(phone, text, chatId);
  // PIPELINE_AUTORUN=false leaves the order at intake for an external driver — the
  // Render Workflow, a manual retry, or the integration test.
  if (order && process.env.PIPELINE_AUTORUN !== "false") await buildAndShip(order);
}

// ---- hosted customer sites ----
app.get<{ Params: { slug: string } }>("/s/:slug", async (req, reply) => {
  const html = readSite(req.params.slug);
  if (!html) return reply.code(404).type("text/plain").send("Not found");
  return reply.type("text/html; charset=utf-8").header("cache-control", "no-store").send(html);
});

app.get<{ Params: { slug: string; idx: string } }>("/s/:slug/v:idx", async (req, reply) => {
  const idx = Number(req.params.idx);
  if (!Number.isInteger(idx)) return reply.code(400).send("bad variant");
  const html = readSite(req.params.slug, `v${idx}.html`);
  if (!html) return reply.code(404).type("text/plain").send("Not found");
  return reply.type("text/html; charset=utf-8").header("cache-control", "no-store").send(html);
});

// ---- Terac panelist study ----
app.get<{ Params: { orderId: string } }>("/study/:orderId", async (req, reply) => {
  const order = getOrder(req.params.orderId);
  if (!order) return reply.code(404).type("text/plain").send("Study not found");
  const variants = variantsFor(order.id);
  if (!variants.length) return reply.code(409).type("text/plain").send("Study not ready yet");

  const headlines = variants.map((v) => {
    const html = readSite(order.slug!, `v${v.idx}.html`) ?? "";
    return html.match(/<h1[^>]*>([^<]+)<\/h1>/)?.[1] ?? "";
  });
  return reply.type("text/html; charset=utf-8").send(studyPage(order.id, variants, headlines));
});

app.post<{ Params: { orderId: string }; Body: Record<string, string> }>(
  "/study/:orderId/vote",
  async (req, reply) => {
    const order = getOrder(req.params.orderId);
    if (!order) return reply.code(404).send("Study not found");

    const b = req.body ?? {};
    const idx = Number(b.variant_idx);
    if (!Number.isInteger(idx)) return reply.code(400).send("pick a version");

    recordVote({
      order_id: order.id,
      variant_idx: idx,
      clearest_idx: Number.isInteger(Number(b.clearest_idx)) ? Number(b.clearest_idx) : null,
      trust: b.trust ? Number(b.trust) : null,
      would_pay: b.would_pay !== undefined ? Number(b.would_pay) : null,
      comment: b.comment?.slice(0, 500) || null,
      voter: (req.headers["x-forwarded-for"] as string)?.split(",")[0] ?? null,
    });
    logDecision({
      agent: "ceo",
      type: "vote_received",
      orderId: order.id,
      output: { pick: idx, total: votesFor(order.id).length },
    });
    return reply.type("text/html; charset=utf-8").send(thanksPage());
  },
);

/**
 * Step endpoints the Render Workflow calls. Each maps to one §4 pipeline step and is
 * re-runnable, so Render's retries are safe. Guarded by a shared token — the workflow
 * runs outside this service's private network.
 */
function internalOk(req: { headers: Record<string, unknown> }): boolean {
  const expected = process.env.INTERNAL_TOKEN;
  return !expected || req.headers["x-internal-token"] === expected;
}

app.post<{ Params: { step: string }; Body: { orderId?: string } }>(
  "/internal/steps/:step",
  async (req, reply) => {
    if (!internalOk(req)) return reply.code(401).send({ error: "bad internal token" });
    const step = req.params.step as StepName;
    if (!STEPS.includes(step)) return reply.code(404).send({ error: `unknown step ${step}` });

    const orderId = req.body?.orderId;
    if (!orderId) return reply.code(400).send({ error: "orderId required" });

    try {
      const out = await STEP_FNS[step](orderId);
      logDecision({ agent: "ceo", type: `step:${step}`, orderId, output: out });
      return { step, orderId, result: out };
    } catch (err) {
      logDecision({ agent: "ceo", type: `step_failed:${step}`, orderId, output: String(err) });
      return reply.code(500).send({ step, orderId, error: String(err) });
    }
  },
);

/** Most recent order for a handle — the lookup the revision path already relies on. */
app.get<{ Params: { phone: string } }>("/internal/orders/by-phone/:phone", async (req, reply) => {
  if (!internalOk(req)) return reply.code(401).send({ error: "bad internal token" });
  const order = latestOrderForPhone(decodeURIComponent(req.params.phone));
  if (!order) return reply.code(404).send({ error: "not found" });
  return { order, variants: variantsFor(order.id) };
});

/** Order state, for the workflow driver and for operational debugging. */
app.get<{ Params: { id: string } }>("/internal/orders/:id", async (req, reply) => {
  if (!internalOk(req)) return reply.code(401).send({ error: "bad internal token" });
  const order = getOrder(req.params.id);
  if (!order) return reply.code(404).send({ error: "not found" });
  return { order, variants: variantsFor(order.id), payments: agentpay.paymentsForOrder(order.id) };
});

/** Run the remaining pipeline in-process — the manual-retry path for a stuck order. */
app.post<{ Params: { id: string } }>("/internal/orders/:id/run", async (req, reply) => {
  if (!internalOk(req)) return reply.code(401).send({ error: "bad internal token" });
  const order = getOrder(req.params.id);
  if (!order) return reply.code(404).send({ error: "not found" });
  await buildAndShip(order);
  return { order: getOrder(order.id) };
});

// ---- dashboard feed (consumed by the Lovable page) ----
app.get("/api/dashboard", async (_req, reply) => {
  reply.header("access-control-allow-origin", "*");
  return dashboard();
});

const port = config.port;
await app.listen({ port, host: "0.0.0.0" });
app.log.info(`landline up on ${config.baseUrl}`);

if (has.linq() && process.env.LINQ_AUTO_SUBSCRIBE === "true") {
  await linq.subscribeWebhook(`${config.baseUrl}/webhooks/linq`);
  app.log.info("linq webhook subscribed");
}
