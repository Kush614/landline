import { createHmac, timingSafeEqual } from "node:crypto";
import { config, has } from "../config.js";
import { req, softly } from "../http.js";
import { logDecision } from "../log.js";

const auth = () => ({
  "content-type": "application/json",
  Authorization: `Bearer ${config.linq.apiKey}`,
});

interface SendResult {
  chat_id?: string;
  message?: { id?: string };
}

/** Tracks which chats we've already sent into, so the no-links-on-first-message rule holds. */
const greeted = new Set<string>();

/**
 * Linq sandbox forbids links in the first outbound message of a conversation.
 * We send a link-free ack first and let the URL follow in the next message.
 */
const hasLink = (t: string) => /\bhttps?:\/\/|\b[\w-]+\.(?:com|sh|dev|io|app|co)\b/i.test(t);

/**
 * +1 555 01xx is the reserved-for-fiction range. Seeded demo orders use it, so we
 * log those messages instead of firing them at a real carrier.
 */
export const isFictionalNumber = (phone: string) => /^\+?1?\s*\(?555\)?[\s.-]?01\d{2}/.test(phone);

export async function sendText(to: string, text: string, chatId?: string): Promise<string | undefined> {
  if (!has.linq() || isFictionalNumber(to)) {
    logDecision({ agent: "system", type: "linq_stub_send", input: to, output: text });
    return chatId;
  }

  const key = chatId ?? to;
  if (!greeted.has(key) && hasLink(text)) {
    await sendText(to, "On it — one moment.", chatId);
  }

  const result = await softly<SendResult | undefined>(
    "linq.sendText",
    async () =>
      chatId
        ? await req<SendResult>(`${config.linq.baseUrl}/chats/${chatId}/messages`, {
            method: "POST",
            headers: auth(),
            body: JSON.stringify({ message: { parts: [{ type: "text", value: text }] } }),
          })
        : await req<SendResult>(`${config.linq.baseUrl}/messages`, {
            method: "POST",
            headers: auth(),
            body: JSON.stringify({ to: [to], message: { parts: [{ type: "text", value: text }] } }),
          }),
    undefined,
  );

  greeted.add(key);
  if (result?.chat_id) greeted.add(result.chat_id);
  logDecision({ agent: "ceo", type: "sms_sent", input: to, output: text });
  return result?.chat_id ?? chatId;
}

/** Typing indicator as the loading state (§5.3). Soft-fails — it is cosmetic. */
export async function sendTyping(chatId: string | undefined, to: string) {
  if (!has.linq() || !chatId) return;
  await softly(
    "linq.typing",
    () =>
      req(`${config.linq.baseUrl}/chats/${chatId}/typing`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ state: "typing" }),
      }),
    undefined,
  );
}

export async function subscribeWebhook(url: string) {
  if (!has.linq()) return;
  return softly(
    "linq.subscribeWebhook",
    () =>
      req(`${config.linq.baseUrl}/webhook-subscriptions`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ url, events: ["message.received"] }),
      }),
    undefined,
  );
}

/**
 * Standard-Webhooks style verification: HMAC-SHA256 over "{id}.{timestamp}.{body}",
 * base64, constant-time compared, rejecting timestamps older than 5 minutes.
 */
export function verifySignature(headers: Record<string, string | string[] | undefined>, rawBody: string): boolean {
  const secret = config.linq.webhookSecret;
  if (!secret) return true; // unset in local dev; required in prod

  const get = (k: string) => {
    const v = headers[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const id = get("webhook-id");
  const ts = get("webhook-timestamp");
  const sig = get("webhook-signature");
  if (!id || !ts || !sig) return false;

  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(age) || age > 300) return false;

  const key = secret.startsWith("whsec_") ? Buffer.from(secret.slice(6), "base64") : Buffer.from(secret);
  const expected = createHmac("sha256", key).update(`${id}.${ts}.${rawBody}`).digest("base64");

  // Header may carry several space-separated "v1,<sig>" values.
  return sig.split(" ").some((part) => {
    const value = part.includes(",") ? part.split(",")[1] : part;
    const a = Buffer.from(value);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

export interface InboundMessage {
  phone: string;
  text: string;
  chatId?: string;
  isReaction: boolean;
  reaction?: string;
}

/**
 * Parses a `message.received` webhook.
 *
 * The documented shape (webhook_version 2026-02-03) nests these deeper than the
 * quickstart's send payload does, which is what made our first real inbound text
 * silently vanish — we accepted it with a 202 and then found no sender:
 *   sender  -> data.sender_handle.handle
 *   chat id -> data.chat.id
 *   text    -> data.parts[].value
 * The older flat fields are kept as fallbacks in case the sandbox differs.
 */
export function parseInbound(payload: any): InboundMessage | null {
  const d = payload?.data ?? payload?.message ?? payload ?? {};

  const chatId = d.chat?.id ?? d.chat_id ?? d.chatId ?? payload?.chat_id ?? undefined;

  const sender = d.sender_handle ?? d.from ?? d.sender ?? d.author ?? d.participant ?? payload?.from;
  const phone =
    typeof sender === "string"
      ? sender
      : sender?.handle ?? sender?.phone_number ?? sender?.number ?? d.from_number;
  if (!phone) return null;

  // Never act on our own outbound messages — that is an infinite reply loop.
  if (d.direction === "outbound" || sender?.is_me === true) return null;

  const parts = d.parts ?? d.message?.parts ?? [];
  const textPart = Array.isArray(parts) ? parts.find((p: any) => p?.type === "text") : undefined;
  const text = (textPart?.value ?? d.text ?? d.body ?? "").toString().trim();

  const reactionPart = Array.isArray(parts)
    ? parts.find((p: any) => p?.type === "reaction" || p?.type === "tapback")
    : undefined;
  const reaction = reactionPart?.value ?? d.reaction ?? d.tapback;

  return { phone, text, chatId, isReaction: !!reaction, reaction };
}
