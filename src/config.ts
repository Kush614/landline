import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Minimal .env loader — no dotenv dependency, keeps cold start fast on Render.
const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, raw] = m;
    if (process.env[k] !== undefined) continue;
    process.env[k] = raw.replace(/^["']|["']$/g, "");
  }
}

const s = (k: string, fallback = "") => process.env[k] ?? fallback;
const b = (k: string, fallback: boolean) => {
  const v = process.env[k];
  return v === undefined ? fallback : v === "true" || v === "1";
};

export const config = {
  port: Number(s("PORT", "3000")),
  baseUrl: s("BASE_URL", `http://localhost:${s("PORT", "3000")}`),

  linq: {
    apiKey: s("LINQ_API_KEY"),
    phoneNumber: s("LINQ_PHONE_NUMBER"),
    webhookSecret: s("LINQ_WEBHOOK_SECRET"),
    baseUrl: s("LINQ_BASE_URL", "https://api.linqapp.com/api/partner/v3"),
  },
  stripe: {
    paymentLink: s("STRIPE_PAYMENT_LINK"),
    readKey: s("STRIPE_READ_KEY"),
  },
  terac: {
    apiKey: s("TERAC_API_KEY"),
    baseUrl: s("TERAC_BASE_URL", "https://terac.com/api/external/v2"),
    projectId: s("TERAC_PROJECT_ID"),
  },
  replay: {
    apiKey: s("REPLAY_API_KEY"),
    baseUrl: s("REPLAY_BASE_URL", "https://loop-qa.replay.io/api/v1"),
  },
  superserve: { apiKey: s("SUPERSERVE_API_KEY") },
  pioneer: {
    apiKey: s("PIONEER_API_KEY"),
    baseUrl: s("PIONEER_BASE_URL", "https://api.pioneer.ai/v1"),
    copyModel: s("PIONEER_COPY_MODEL", "nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16"),
    piiModel: s("PIONEER_PII_MODEL", "fastino/gliner2-privacy-filter-PII-multi"),
  },
  band: {
    apiKey: s("BAND_API_KEY"),
    agentId: s("BAND_AGENT_ID"),
    roomId: s("BAND_ROOM_ID"),
    baseUrl: s("BAND_BASE_URL", "https://app.band.ai/api/v1/agent"),
    enabled: b("BAND_ENABLED", true),
  },
  render: {
    apiKey: s("RENDER_API_KEY"),
    ownerId: s("RENDER_OWNER_ID"),
    baseUrl: "https://api.render.com/v1",
  },

  features: {
    whop: b("FEATURE_WHOP", false),
    egoist: b("FEATURE_EGOIST", false),
    solari: b("FEATURE_SOLARI", false),
    sandbox0: b("FEATURE_SANDBOX0", false),
  },
};

/** A sponsor is "live" only when its key is present; everything else falls back. */
export const has = {
  linq: () => !!config.linq.apiKey,
  terac: () => !!config.terac.apiKey,
  replay: () => !!config.replay.apiKey,
  superserve: () => !!config.superserve.apiKey,
  pioneer: () => !!config.pioneer.apiKey,
  band: () => config.band.enabled && !!config.band.apiKey,
  render: () => !!config.render.apiKey && !!config.render.ownerId,
  stripe: () => !!config.stripe.paymentLink,
};
