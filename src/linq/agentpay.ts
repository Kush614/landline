import { randomUUID } from "node:crypto";
import { config, has } from "../config.js";
import { req, softly, HttpError } from "../http.js";
import { logDecision, logRevenue } from "../log.js";
import {
  getConnection,
  upsertConnection,
  createPayment,
  updatePayment,
  paymentsFor,
  type Payment,
} from "../db.js";

/**
 * Linq Agent Pay — Apple Pay inside the thread, settling to our Stripe account.
 *
 * Four endpoints, taken from Linq's `llms-full.txt` (the public quickstart doesn't
 * cover payments):
 *   POST /v3/payments/handles/{handle}/connect   -> { connect_id }
 *   POST /v3/payments/handles/{handle}/verify    { connect_id, code }
 *   POST /v3/payments                            { handle, amount_cents, ... }
 *   GET  /v3/payments/{paymentId}/credentials    -> { user_token, fetch_url }
 *
 * Connecting a handle is a two-step dance: we request a code, Linq texts it to the
 * customer, the customer texts it back to us, we verify. That state lives in
 * `payment_connections` because it spans several inbound messages.
 *
 * UNVERIFIED: the create-payment path (`POST /v3/payments`) is inferred — the doc
 * showed the body but not the route — and the credentials handoff (`user_token` +
 * `fetch_url`) is documented as "for the agent to redeem" without saying how the
 * redemption surfaces in iMessage. Both are overridable by env and every call is
 * soft-failed, so a wrong guess degrades to the Stripe link rather than blocking a
 * sale. Confirm with Linq before relying on this on stage.
 */

const auth = () => ({
  "content-type": "application/json",
  Authorization: `Bearer ${config.linq.apiKey}`,
});

const PAYMENTS_PATH = process.env.LINQ_PAYMENTS_PATH ?? "/payments";
const base = () => config.linq.baseUrl;

export const agentPayEnabled = () =>
  has.linq() && process.env.LINQ_AGENT_PAY !== "false";

/** True once the customer has completed the code dance and can be charged. */
export const isConnected = (handle: string) => getConnection(handle)?.status === "verified";

/** Step 1 — ask Linq to text this handle a verification code. */
export async function requestConnect(handle: string, orderId?: string): Promise<string | null> {
  if (!agentPayEnabled()) return null;

  const connectId = await softly<string | null>(
    "linq.agentpay.connect",
    async () => {
      const res = await req<{ connect_id?: string; id?: string }>(
        `${base()}${PAYMENTS_PATH}/handles/${encodeURIComponent(handle)}/connect`,
        { method: "POST", headers: auth(), body: "{}" },
      );
      return res?.connect_id ?? res?.id ?? null;
    },
    null,
    orderId,
  );

  if (!connectId) {
    logDecision({ agent: "sales", type: "agentpay_connect_failed", orderId, input: handle });
    return null;
  }

  upsertConnection(handle, { connect_id: connectId, status: "pending", requested_at: new Date().toISOString() });
  logDecision({ agent: "sales", type: "agentpay_connect_requested", orderId, input: handle, output: connectId });
  return connectId;
}

/** Step 2 — the customer texted the code back. */
export async function verifyConnect(handle: string, code: string, orderId?: string): Promise<boolean> {
  const conn = getConnection(handle);
  if (!agentPayEnabled() || !conn?.connect_id) return false;

  const ok = await softly(
    "linq.agentpay.verify",
    async () => {
      await req(`${base()}${PAYMENTS_PATH}/handles/${encodeURIComponent(handle)}/verify`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ connect_id: conn.connect_id, code }),
      });
      return true;
    },
    false,
    orderId,
  );

  upsertConnection(handle, {
    status: ok ? "verified" : "failed",
    verified_at: ok ? new Date().toISOString() : null,
  });
  logDecision({
    agent: "sales",
    type: ok ? "agentpay_verified" : "agentpay_verify_failed",
    orderId,
    input: handle,
  });
  return ok;
}

export interface PaymentHandoff {
  paymentId: string;
  linqPaymentId: string;
  userToken?: string;
  fetchUrl?: string;
}

/** Step 3 + 4 — create the payment, then fetch the credentials the customer redeems. */
export async function createAgentPayment(input: {
  handle: string;
  orderId: string;
  amountCents: number;
  description: string;
}): Promise<PaymentHandoff | null> {
  if (!agentPayEnabled() || !isConnected(input.handle)) return null;

  const created = await softly<{ id?: string; payment_id?: string } | null>(
    "linq.agentpay.createPayment",
    () =>
      req(`${base()}${PAYMENTS_PATH}`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({
          handle: input.handle,
          amount_cents: input.amountCents,
          currency: "usd",
          description: input.description,
          merchant: { name: "LANDLINE", url: "landline.sh" },
        }),
      }),
    null,
    input.orderId,
  );

  const linqPaymentId = created?.id ?? created?.payment_id;
  if (!linqPaymentId) {
    logDecision({ agent: "sales", type: "agentpay_create_failed", orderId: input.orderId });
    return null;
  }

  const localId = randomUUID();
  createPayment({
    id: localId,
    order_id: input.orderId,
    handle: input.handle,
    linq_payment_id: linqPaymentId,
    amount_cents: input.amountCents,
    status: "created",
    fetch_url: null,
  });

  const creds = await softly<{ user_token?: string; fetch_url?: string } | null>(
    "linq.agentpay.credentials",
    () => req(`${base()}${PAYMENTS_PATH}/${linqPaymentId}/credentials`, { headers: auth() }),
    null,
    input.orderId,
  );

  if (creds?.fetch_url) updatePayment(localId, { fetch_url: creds.fetch_url, status: "awaiting_payment" });

  logDecision({
    agent: "sales",
    type: "agentpay_payment_created",
    orderId: input.orderId,
    input: { amountCents: input.amountCents },
    output: { linqPaymentId, hasCredentials: !!creds?.fetch_url },
  });
  logRevenue({
    orderId: input.orderId,
    handle: input.handle,
    amountCents: input.amountCents,
    rail: "agent_pay",
    status: "created",
  });

  return {
    paymentId: localId,
    linqPaymentId,
    userToken: creds?.user_token,
    fetchUrl: creds?.fetch_url,
  };
}

/**
 * The customer-facing pay instruction. Agent Pay when the handle is connected,
 * the Stripe link otherwise — we never leave a customer with no way to pay.
 */
export async function payInstruction(input: {
  handle: string;
  orderId: string;
  amountCents: number;
  description: string;
  chatId?: string;
}): Promise<{ text: string; rail: "agent_pay" | "stripe" | "none" }> {
  if (agentPayEnabled() && isConnected(input.handle)) {
    const handoff = await createAgentPayment(input);
    if (handoff?.fetchUrl) {
      return { text: `Tap to pay with Apple Pay: ${handoff.fetchUrl}`, rail: "agent_pay" };
    }
  }
  if (config.stripe.paymentLink) {
    return { text: `Pay here: ${config.stripe.paymentLink}`, rail: "stripe" };
  }
  return { text: "(payment link not configured yet)", rail: "none" };
}

/**
 * Offers Apple Pay to a customer who isn't connected yet. Called after we ship, so
 * the ask lands when they've already seen the page.
 */
export async function offerConnect(handle: string, orderId: string): Promise<string | null> {
  if (!agentPayEnabled() || isConnected(handle)) return null;
  const connectId = await requestConnect(handle, orderId);
  if (!connectId) return null;
  return "To pay with Apple Pay right here, text me back the 6-digit code Linq just sent you.";
}

/** A bare 6-digit number from a connected-pending handle is a verification code. */
export const looksLikeCode = (text: string) => /^\s*\d{6}\s*$/.test(text);

export const hasPendingConnect = (handle: string) => getConnection(handle)?.status === "pending";

export const paymentsForOrder = (orderId: string): Payment[] => paymentsFor(orderId);
