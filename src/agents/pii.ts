import { config, has } from "../config.js";
import { req, softly } from "../http.js";
import { logDecision } from "../log.js";

const ENTITIES = [
  "person",
  "email",
  "phone_number",
  "street_address",
  "credit_card_number",
  "ssn",
  "api_key",
  "password",
];

/** Regex net so we never store raw PII even when Pioneer is unreachable. */
function localScrub(text: string) {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.]{2,}/g, "[EMAIL]")
    .replace(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, "[PHONE]")
    .replace(/\b(?:\d[ -]*?){13,16}\b/g, "[CARD]")
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[SSN]")
    .replace(/\b(sk|rk|pk)_[A-Za-z0-9_]{8,}\b/g, "[SECRET]");
}

interface PiiEntity {
  label?: string;
  type?: string;
  text?: string;
  value?: string;
}

/**
 * GLiNER2-PII on Pioneer, with a regex fallback. Runs before the brief is stored,
 * shown to Terac panelists, or posted into Band (§1.1).
 */
export async function scrubPII(text: string, orderId?: string): Promise<string> {
  const local = localScrub(text);
  if (!has.pioneer()) {
    logDecision({ agent: "system", type: "pii_scrub", orderId, input: "local-regex", output: local });
    return local;
  }

  const scrubbed = await softly(
    "pioneer.gliner2-pii",
    async () => {
      const res = await req<{ choices?: { message?: { content?: string } }[]; entities?: PiiEntity[] }>(
        `${config.pioneer.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "X-API-Key": config.pioneer.apiKey },
          body: JSON.stringify({
            model: config.pioneer.piiModel,
            messages: [{ role: "user", content: text }],
            schema: { entities: ENTITIES },
            include_spans: true,
          }),
        },
      );

      // The encoder returns entities either top-level or as JSON in the message content.
      let entities: PiiEntity[] = res.entities ?? [];
      const content = res.choices?.[0]?.message?.content;
      if (!entities.length && content) {
        try {
          const parsed = JSON.parse(content);
          entities = parsed.entities ?? parsed ?? [];
        } catch {
          /* leave empty, regex pass already applied */
        }
      }

      let out = text;
      for (const e of entities) {
        const value = e.text ?? e.value;
        const label = (e.label ?? e.type ?? "pii").toUpperCase();
        if (value && value.length > 1) out = out.split(value).join(`[${label}]`);
      }
      return localScrub(out);
    },
    local,
    orderId,
  );

  logDecision({
    agent: "system",
    type: "pii_scrub",
    orderId,
    input: `${config.pioneer.piiModel}`,
    output: scrubbed,
  });
  return scrubbed;
}
