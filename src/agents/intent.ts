import { logDecision } from "../log.js";

export type Intent =
  | { kind: "brief" }
  | { kind: "revision" }
  | { kind: "pay" }
  | { kind: "code"; code: string }
  | { kind: "chitchat"; reply: string };

/**
 * A phone number is our whole storefront, so anything a stranger types arrives here.
 * Without a gate, a judge texting "cool" at the demo spawns a site called "cool".
 * A brief has to actually describe something to build.
 */

const CODE = /^\s*\d{6}\s*$/;
const PAY = /^\s*(pay|payment|invoice|how do i pay|checkout)[.!?]?\s*$/i;

/** Short, contentless replies. Ordered so the reply we send back fits the message. */
const CHITCHAT: { re: RegExp; reply: string }[] = [
  { re: /^\s*(thanks|thank you|ty|cheers|nice|cool|awesome|great|love it|perfect|sweet|dope|amazing|beautiful)[.!]*\s*$/i,
    reply: "Glad you like it. Text me any change you want, or PAY to check out." },
  { re: /^\s*(yes|yep|yeah|yup|sure|ok|okay|k|no|nope|nah|maybe)[.!]*\s*$/i,
    reply: "Got it. Tell me what you'd like the page to say, or text PAY to check out." },
  { re: /^\s*(hi|hey|hello|yo|sup|howdy|good morning|good afternoon)[.!]*\s*$/i,
    reply: "Hi! Describe the page you want — what the business is, who it's for — and I'll build it in a few minutes." },
  { re: /^\s*(\?+|what|huh|who is this|what is this|how does this work)[.!?]*\s*$/i,
    reply: "I build one-page websites over text. Describe your business in a sentence or two and I'll have a live page for you in a few minutes." },
  { re: /^\s*(stop|unsubscribe|quit|cancel)[.!]*\s*$/i,
    reply: "No problem — I won't message you again unless you text me first." },
  { re: /^[\p{Extended_Pictographic}\s‍️]+$/u,
    reply: "Glad you like it. Text me any change you want, or PAY to check out." },
];

const MIN_BRIEF_WORDS = 4;

/**
 * Words that make a short message a real instruction rather than filler, so
 * "make it darker" (3 words) still counts as a revision.
 */
const ACTIONABLE =
  /\b(make|change|add|remove|swap|move|rename|update|darker|lighter|bigger|smaller|bolder|color|colour|headline|button|cta|font|logo|price|pricing|serif|centered|split|dark|light)\b/i;

export function classify(text: string, opts: { hasPriorOrder: boolean; priorIsLive: boolean }): Intent {
  const trimmed = text.trim();

  if (CODE.test(trimmed)) return { kind: "code", code: trimmed };
  if (PAY.test(trimmed)) return { kind: "pay" };

  for (const c of CHITCHAT) {
    if (c.re.test(trimmed)) return { kind: "chitchat", reply: c.reply };
  }

  const words = trimmed.split(/\s+/).filter(Boolean);
  const actionable = ACTIONABLE.test(trimmed);

  // An existing customer giving a short instruction is revising.
  if (opts.hasPriorOrder && opts.priorIsLive && actionable && words.length <= 25) {
    return { kind: "revision" };
  }

  // Too short to describe a business, and not an instruction we recognise.
  if (words.length < MIN_BRIEF_WORDS && !actionable) {
    return {
      kind: "chitchat",
      reply: opts.hasPriorOrder
        ? "Not sure what you'd like me to change — try something like \"make it darker\" or \"headline should say X\"."
        : "Tell me a bit more and I'll build it — what the business is, who it's for, and what you want visitors to do.",
    };
  }

  if (opts.hasPriorOrder && opts.priorIsLive && actionable) return { kind: "revision" };
  return { kind: "brief" };
}

export function classifyAndLog(
  text: string,
  opts: { hasPriorOrder: boolean; priorIsLive: boolean; phone: string },
): Intent {
  const intent = classify(text, opts);
  logDecision({
    agent: "ceo",
    type: "intent",
    input: text.slice(0, 120),
    output: intent.kind,
  });
  return intent;
}
