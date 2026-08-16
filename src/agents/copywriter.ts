import { config, has } from "../config.js";
import { req } from "../http.js";
import { logDecision } from "../log.js";
import type { Copy } from "../builder/types.js";

const SYSTEM = `You are a senior landing-page copywriter. Given a business brief, write copy for ONE single-page site.
Rules: concrete over clever. No filler like "revolutionary", "seamless", "unlock", "elevate", "game-changing".
Headline <= 9 words and says what the thing actually is. Subhead <= 22 words, names the audience and the outcome.
CTA is 2-4 words, a verb the visitor can act on now. Exactly 3 features, each title <= 4 words, body <= 18 words.
Return ONLY minified JSON, no markdown fence, matching:
{"brand":"","headline":"","subhead":"","cta":"","features":[{"title":"","body":""}],"footer":""}`;

/**
 * Strips the request wrapper ("build me a landing page for X that does Y") down to
 * the business itself, so the fallback headline is about the customer, not the order.
 */
/**
 * Removes the conversational wrapper a real customer puts in front of the actual
 * business: greetings, self-introductions, contact details. Shared by both the
 * subject extractor and brand detection — when only one of them stripped these,
 * "Hi I'm Dana Okonkwo, ... I run Ash & Ember" produced the brand "I'm".
 */
function stripOpeners(input: string): string {
  let s = input.trim();
  s = s.replace(/^\s*(?:hi|hey|hello)[,!\s]+/i, "");
  s = s.replace(/^\s*(?:i'?m|i am|my name is|this is)\s+[^,.\n]{2,40}[,.]\s*/i, "");
  s = s.replace(/^\s*(?:we'?re|we are)\s+/i, "");
  s = s.replace(/^\s*(?:call|text|email|reach)\s+me[^,.\n]{0,60}[,.—-]\s*/i, "");
  s = s.replace(/^\s*(?:i|we)\s+(?:run|own|have|operate)\s+/i, "");
  return s;
}

function subjectOf(brief: string): string {
  let s = stripOpeners(brief);
  s = s.replace(
    /^\s*(?:can you|could you|please|i(?:'d| would) like|i need|i want|make|build|create|design|get)\s+(?:me\s+)?(?:a|an|the)?\s*/i,
    "",
  );
  s = s.replace(/^\s*(?:a|an|the)\s+/i, "");
  s = s.replace(/^\s*(?:simple|clean|nice|quick|basic|modern|one[- ]page|single[- ]page)\s+/i, "");
  s = s.replace(/^\s*(?:landing\s+page|website|web\s*site|web\s*page|site|page)\s*/i, "");
  // "one page for a two-person studio" leaves a dangling "for" once the page word goes.
  s = s.replace(/^\s*(?:for|about|to\s+promote|promoting)\s+/i, "");
  s = s.replace(/^\s*(?:a|an|the|my|our)\s+/i, "");
  // Split on sentence ends only — a comma usually separates the name from its
  // description ("Fernway, a coffee roaster"), which is exactly what we want to keep.
  return s.split(/[.\n]/)[0].trim() || "your business";
}

/**
 * Cuts at the first clause boundary so we never emit "...in Oakland that, without
 * the hassle". Falls back to a word boundary, then a hard slice.
 */
function clip(s: string, max: number): string {
  // Participles are the common mid-phrase trap: "…engineering studio taking on
  // seismic" reads as a truncation, where "…engineering studio" reads as finished.
  // Prepositions like "in" are deliberately absent — "roaster in Oakland" is fine.
  const clause = s.search(
    /,| that | which | who | and | where | so that | taking | offering | serving | providing | selling | making | building | creating | licensing | renting | running | designing | specialis| specializ| helping | working /i,
  );
  let out = clause > 12 ? s.slice(0, clause) : s;
  if (out.length > max) {
    const cut = out.slice(0, max);
    const sp = cut.lastIndexOf(" ");
    out = sp > 12 ? cut.slice(0, sp) : cut;
  }
  // A headline ending "cold plunge &" reads as a truncation. Drop trailing
  // conjunctions and symbols along with the punctuation.
  // Also drop a trailing preposition: "knife sharpeners in" reads as a truncation.
  return out
    .replace(/[,;:\s]+$/, "")
    .replace(/\s+(?:&|and|or|with|plus|\+|-|—|in|on|at|for|to|of|from|by|near)$/i, "")
    .replace(/[,;:\s]+$/, "");
}

function fallbackCopy(brief: string, angle: number): Copy {
  const brand = guessBrand(brief);
  const subject = subjectOf(brief);
  // Trim the brand off the front so we don't print "Fernway — Fernway".
  const escaped = brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stripped = subject.replace(new RegExp(`^${escaped}\\b[,\\s-]*(?:is\\s+)?(?:a|an|the)?\\s*`, "i"), "").trim();
  const descriptor = stripped && stripped.toLowerCase() !== brand.toLowerCase() ? stripped : subject;
  const short = clip(descriptor, 42);

  // Brand-anchored on purpose: the fallback runs when Pioneer is down, so it has to
  // read cleanly for any brief rather than cleverly for some. Drop the prefix when
  // the descriptor already contains the brand — "Studio: …engineering studio".
  const echoes = short.toLowerCase().includes(brand.toLowerCase());
  const heads = [
    `${brand}, done properly`,
    `${brand} without the hassle`,
    echoes ? cap(short) : `${brand}: ${short}`,
  ];
  const subs = [
    `Everything you need from ${brand}. Nothing you don't.`,
    `Built for people who want ${clip(descriptor, 60)} sorted today, not next quarter.`,
    `Clear pricing, fast setup, and real people behind ${brand}.`,
  ];
  const ctas = ["Get started", "Book a call", "See pricing"];
  return {
    brand,
    headline: heads[angle % 3],
    subhead: subs[angle % 3],
    cta: ctas[angle % 3],
    features: [
      { title: "Fast setup", body: "Live in minutes, not weeks. No install, no onboarding calls required." },
      { title: "Fair pricing", body: "One clear price. No contracts, no surprise line items at renewal." },
      { title: "Real support", body: "Message a human and get an answer the same working day." },
    ],
    footer: `© ${new Date().getFullYear()} ${brand}. All rights reserved.`,
  };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const STOPWORDS = new Set([
  "I", "We", "My", "The", "A", "An", "Hi", "Hey", "Hello", "Please", "Can", "Could",
  // Capitalised words that are almost always part of a place, not a business name.
  // "…retrofits in the East Bay" used to yield the brand "East".
  "East", "West", "North", "South", "Bay", "Area", "City", "County", "Street", "Ave",
  "Avenue", "Road", "Valley", "Heights", "Park", "Downtown", "Monday", "Tuesday",
  "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
]);

function guessBrand(raw: string): string {
  const brief = stripOpeners(raw);
  const quoted = brief.match(/["“']([^"”']{2,30})["”']/);
  if (quoted) return quoted[1].trim();
  // \p{Lu}\p{L} rather than [A-Za-z]: "Rún" and "Café" are brands, not "R" and "Caf".
  const named = brief.match(/\b(?:called|named|for)\s+(\p{Lu}[\p{L}\d&'-]*(?:\s+(?:&\s+)?\p{Lu}[\p{L}\d&'-]*){0,2})/u);
  if (named && !STOPWORDS.has(named[1].split(/\s+/)[0])) return named[1].trim();

  // Prefer a multi-word proper noun, including "X & Y" — that is nearly always the
  // business name, where a lone capitalised word is often a place or a person.
  // {2,} and no apostrophe in the first token: "I'm Dana" is not a business name.
  const multi = brief.match(/\b(\p{Lu}[\p{L}\d-]{2,}(?:\s+&\s+|\s+)\p{Lu}[\p{L}\d'-]{1,})\b/u);
  if (multi && !STOPWORDS.has(multi[1].split(/\s+/)[0])) return multi[1].trim();

  const capd = [...brief.matchAll(/\b(\p{Lu}[\p{L}\d-]{2,})\b/gu)].map((m) => m[1]).find((w) => !STOPWORDS.has(w));
  return capd ?? "Studio";
}

function stripFence(s: string) {
  return s.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
}

async function pioneerCopy(brief: string, angle: number, orderId?: string): Promise<Copy | null> {
  const angles = [
    "Angle: lead with the outcome the customer gets.",
    "Angle: lead with who it is for and the problem it removes.",
    "Angle: lead with credibility and craft; slightly more editorial voice.",
  ];
  const res = await req<{ choices?: { message?: { content?: string } }[] }>(
    `${config.pioneer.baseUrl}/chat/completions`,
    {
      method: "POST",
      timeoutMs: 25_000,
      headers: { "content-type": "application/json", "X-API-Key": config.pioneer.apiKey },
      body: JSON.stringify({
        model: config.pioneer.copyModel,
        temperature: 0.7,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: `${angles[angle % 3]}\n\nBrief: ${brief}` },
        ],
      }),
    },
  );
  const content = res.choices?.[0]?.message?.content;
  if (!content) return null;
  const parsed = JSON.parse(stripFence(content)) as Copy;
  if (!parsed.headline || !parsed.cta || !Array.isArray(parsed.features)) return null;
  parsed.features = parsed.features.slice(0, 3);
  parsed.brand ||= guessBrand(brief);
  parsed.footer ||= `© ${new Date().getFullYear()} ${parsed.brand}.`;
  return parsed;
}

/**
 * Pioneer failing is not fatal — the template fallback still ships a page — but it
 * must be visible, or we spend the day quietly serving worse copy than we think.
 * A `permission_error` in particular means the account has no plan, which is a
 * one-minute fix nobody will make if it's buried in a log line.
 */
export const pioneerAlarms: { at: string; detail: string }[] = [];

function pioneerAlarm(detail: string, orderId?: string) {
  if (pioneerAlarms.length && pioneerAlarms.at(-1)!.detail === detail) return; // don't spam per-variant
  pioneerAlarms.push({ at: new Date().toISOString(), detail });
  // The native /inference endpoint returns code "card_required" where the
  // OpenAI-compatible one just says "subscribe" — a card must be on file even
  // with the hackathon Pro promo, exactly like Render.
  const hint = /card_required|permission_error|subscribe/i.test(detail)
    ? "\nThe key is valid; the account needs a payment card on file (error code card_required).\nAdd one at https://agent.pioneer.ai/billing — the ZeroHumanHack0826 promo does not replace it."
    : "";
  console.error(
    `\n${"!".repeat(72)}\nPIONEER DEGRADED — copy is coming from the local template, not the open-weight model.\n${detail}${hint}\n${"!".repeat(72)}\n`,
  );
  logDecision({ agent: "copywriter", type: "PIONEER_DEGRADED", orderId, output: detail });
}

/** Copywriter agent (§3.2) — open-weight model on Pioneer, deterministic fallback. */
export async function writeCopy(brief: string, angle: number, orderId?: string): Promise<Copy> {
  const fb = fallbackCopy(brief, angle);
  let copy = fb;

  if (has.pioneer()) {
    try {
      copy = (await pioneerCopy(brief, angle, orderId)) ?? fb;
    } catch (err) {
      pioneerAlarm(err instanceof Error ? err.message.slice(0, 300) : String(err), orderId);
      copy = fb;
    }
  }

  const usedModel = copy !== fb;
  logDecision({
    agent: "copywriter",
    type: "copy_written",
    orderId,
    input: { angle, model: usedModel ? config.pioneer.copyModel : "local-template" },
    output: { headline: copy.headline, cta: copy.cta },
  });
  return copy;
}

/**
 * QA -> Copywriter handoff (§3.3.4). When Replay flags a broken CTA, the copywriter
 * re-emits it rather than the QA agent silently patching the HTML.
 */
export async function rewriteCta(copy: Copy, reason: string, orderId?: string): Promise<Copy> {
  const safe = ["Get started", "Contact us", "See pricing", "Book a call"];
  const next = safe.find((c) => c.toLowerCase() !== copy.cta.toLowerCase()) ?? "Get started";
  logDecision({
    agent: "copywriter",
    type: "cta_rewritten",
    orderId,
    bandDependency: "qa_changes_copywriter",
    input: { reason, was: copy.cta },
    output: { now: next },
  });
  return { ...copy, cta: next };
}

export { fallbackCopy, guessBrand };
