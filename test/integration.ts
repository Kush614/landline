/**
 * On-stage insurance: prove the in-process path and the Render Workflow path produce
 * the same order.
 *
 * The workflow path is the risky one — each task runs in its own instance, so every
 * step has to reload its state instead of inheriting it in memory. This test drives
 * the real `/internal/steps/*` endpoints one at a time, exactly as `runOrder` does,
 * and asserts the resulting order is indistinguishable from one built by the
 * in-process loop.
 *
 *   npx tsx test/integration.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 3899;
const BASE = `http://localhost:${PORT}`;
const TOKEN = "test-internal-token";
const BRIEF = "a landing page for Fernway, a small-batch coffee roaster in Oakland that sells subscription bags";
const STEPS = ["design_copy", "build", "human_test", "qa", "deploy", "notify"];

const workdir = mkdtempSync(join(tmpdir(), "landline-integration-"));
let server: ChildProcess | undefined;
let passed = 0;
let failed = 0;

function check(name: string, cond: unknown, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": TOKEN },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function textIn(phone: string, value: string) {
  await fetch(`${BASE}/webhooks/linq`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ data: { chat_id: `chat-${phone}`, from: phone, parts: [{ type: "text", value }] } }),
  });
}

async function orderFor(phone: string): Promise<any | null> {
  const res = await fetch(`${BASE}/internal/orders/by-phone/${encodeURIComponent(phone)}`, {
    headers: { "x-internal-token": TOKEN },
  });
  if (!res.ok) return null;
  return (await res.json()).order;
}

async function waitFor(phone: string, pred: (o: any) => boolean, ms = 45_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const o = await orderFor(phone);
    if (o && pred(o)) return o;
    await sleep(400);
  }
  throw new Error(`timed out waiting on ${phone}`);
}

/** Everything that should match between the two paths — ids and timings must not. */
function fingerprint(order: any, variants: any[]) {
  return {
    status: order.status,
    tier: order.tier,
    complexity: order.complexity,
    compliance: order.compliance,
    winner_idx: order.winner_idx,
    qa_status: order.qa_status,
    amount_cents: order.amount_cents,
    has_deploy_url: !!order.deploy_url,
    variant_count: variants.length,
    variant_labels: variants.map((v) => v.label),
    replay_status: variants.map((v) => v.replay_status),
  };
}

try {
  console.log("Starting server…");
  server = spawn("npx", ["tsx", "src/server.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      BASE_URL: BASE,
      DATA_DIR: join(workdir, "data"),
      SITES_DIR: join(workdir, "sites"),
      INTERNAL_TOKEN: TOKEN,
      BAND_ENABLED: "true",
      PIPELINE_AUTORUN: "false", // both orders are driven explicitly
      TERAC_INLINE_WAIT_MS: "300",
      TERAC_MIN_VOTES: "1",
      LOG_LEVEL: "warn",
      // Same rule as the unit suite: the integration server must not be able to
      // spend money or text anyone. Blank every paid credential it inherits.
      TERAC_API_KEY: "",
      REPLAY_API_KEY: "",
      SUPERSERVE_API_KEY: "",
      PIONEER_API_KEY: "",
      LINQ_API_KEY: "",
      LINQ_WEBHOOK_SECRET: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr?.on("data", (d) => {
    const s = String(d);
    if (/error|Error/.test(s) && !/TERAC DEGRADED|!!!/.test(s)) process.stderr.write(`  [server] ${s}`);
  });

  let up = false;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) {
        up = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await sleep(400);
  }
  if (!up) throw new Error(`server never became healthy on ${BASE} (is port ${PORT} in use?)`);
  console.log("Server up.\n");

  // ---------------------------------------------------------- in-process path
  console.log("A. In-process path (RENDER_WORKFLOW_ENABLED=false)");
  const phoneA = "+14155550101";
  await textIn(phoneA, BRIEF);
  const intakeA = await waitFor(phoneA, (o) => o.compliance === "APPROVE");
  check("intake completed without running the pipeline", intakeA.status === "intake", `status=${intakeA.status}`);

  await post(`/internal/orders/${intakeA.id}/run`, {});
  const a = await fetch(`${BASE}/internal/orders/${intakeA.id}`, { headers: { "x-internal-token": TOKEN } }).then((r) => r.json());
  check("order went live", a.order.status === "live", `status=${a.order.status}`);
  const fpA = fingerprint(a.order, a.variants);

  // ------------------------------------------------------------ workflow path
  console.log("\nB. Workflow path (each step through /internal/steps/*, as runOrder does)");
  const phoneB = "+14155550202";
  await textIn(phoneB, BRIEF);
  const intakeB = await waitFor(phoneB, (o) => o.compliance === "APPROVE");

  for (const step of STEPS) {
    const out = await post(`/internal/steps/${step}`, { orderId: intakeB.id });
    check(`step ${step} succeeded`, !!out?.result, JSON.stringify(out).slice(0, 150));
  }
  const b = await fetch(`${BASE}/internal/orders/${intakeB.id}`, { headers: { "x-internal-token": TOKEN } }).then((r) => r.json());
  const fpB = fingerprint(b.order, b.variants);

  // ------------------------------------------------------------- the assertion
  console.log("\nC. The two paths agree");
  const same = JSON.stringify(fpA) === JSON.stringify(fpB);
  check(
    "final state is identical across both orchestration paths",
    same,
    same ? "" : `in-process: ${JSON.stringify(fpA)}\n      workflow:   ${JSON.stringify(fpB)}`,
  );
  check("both shipped a reachable page", fpA.has_deploy_url && fpB.has_deploy_url);
  check("both picked a winner", fpA.winner_idx !== null && fpB.winner_idx !== null);
  check("both priced the same tier", fpA.tier === fpB.tier, `${fpA.tier} vs ${fpB.tier}`);

  for (const [label, url] of [["in-process", a.order.deploy_url], ["workflow", b.order.deploy_url]] as const) {
    const res = await fetch(url);
    check(`${label} page serves 200`, res.status === 200, `got ${res.status}`);
  }

  // ------------------------------------------------- steps are individually safe
  console.log("\nD. Render can retry a step without corrupting the order");
  await post(`/internal/steps/qa`, { orderId: intakeB.id });
  await post(`/internal/steps/deploy`, { orderId: intakeB.id });
  const replayed = await fetch(`${BASE}/internal/orders/${intakeB.id}`, { headers: { "x-internal-token": TOKEN } }).then((r) => r.json());
  check(
    "re-running qa + deploy leaves the same final state",
    JSON.stringify(fingerprint(replayed.order, replayed.variants)) === JSON.stringify(fpB),
    JSON.stringify(fingerprint(replayed.order, replayed.variants)),
  );

  // ------------------------------------------------- a code is never a brief
  console.log("\nE. A bare 6-digit text never becomes an order");
  const before = (await fetch(`${BASE}/api/dashboard`).then((r) => r.json())).orders_total;
  await textIn(phoneA, "482913"); // known number, nothing pending
  await textIn("+14155550303", "123456"); // stranger
  await sleep(1500);
  const after = (await fetch(`${BASE}/api/dashboard`).then((r) => r.json())).orders_total;
  check("no junk orders created from verification codes", after === before, `${before} -> ${after}`);

  console.log("\n" + "─".repeat(60));
  console.log(`${passed} passed, ${failed} failed`);
} catch (err) {
  failed++;
  console.error(`\n  ✗ integration run threw: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  server?.kill("SIGKILL");
  rmSync(workdir, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
