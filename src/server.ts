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
import { intake, buildAndShip, revise } from "./pipeline/run.js";
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

app.get("/health", async () => ({
  ok: true,
  ts: new Date().toISOString(),
  sponsors: {
    linq: has.linq(),
    stripe: has.stripe(),
    terac: has.terac(),
    replay: has.replay(),
    superserve: has.superserve(),
    pioneer: has.pioneer(),
    band: has.band(),
    render: has.render(),
  },
}));

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
      await linq.sendText(
        phone,
        config.stripe.paymentLink
          ? `Glad you like it. Pay here and it's yours: ${config.stripe.paymentLink}`
          : `Glad you like it.`,
        prior.chat_id ?? chatId,
      );
    }
    return;
  }

  if (!text) return;

  const prior = latestOrderForPhone(phone);
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
  if (order) await buildAndShip(order);
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
