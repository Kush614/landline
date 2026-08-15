import { task } from "@renderinc/sdk/workflows";
import type { StepName } from "./steps.js";

/**
 * The §4 pipeline as a Render Workflow.
 *
 * Each task run gets its own instance with its own filesystem, so the tasks do not
 * touch SQLite directly — they call the API service, which owns the database, the
 * Band room and the published sites. What Render owns is the orchestration: retries,
 * per-step timeouts, and the run history visible in the dashboard.
 *
 * Deployed as `type: workflow` in render.yaml; the entrypoint is src/workflow-entry.ts.
 */

const API = () => process.env.LANDLINE_API_URL ?? process.env.BASE_URL ?? "http://localhost:3777";
const TOKEN = () => process.env.INTERNAL_TOKEN ?? "";

async function callStep(step: StepName, orderId: string): Promise<unknown> {
  const res = await fetch(`${API()}/internal/steps/${step}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": TOKEN() },
    body: JSON.stringify({ orderId }),
    signal: AbortSignal.timeout(15 * 60_000), // human_test and qa both poll for minutes
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`step ${step} failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  return body ? JSON.parse(body) : null;
}

/** Cheap and deterministic — one retry is plenty. */
const designCopy = task(
  { name: "designCopy", timeoutSeconds: 300, retry: { maxRetries: 1, waitDurationMs: 2000 } },
  (orderId: string) => callStep("design_copy", orderId),
);

const build = task(
  { name: "build", timeoutSeconds: 600, retry: { maxRetries: 2, waitDurationMs: 3000, backoffScaling: 1.5 } },
  (orderId: string) => callStep("build", orderId),
);

/** Waits on real people. Never retry — a retry would launch a second paid study. */
const humanTest = task(
  { name: "humanTest", timeoutSeconds: 900 },
  (orderId: string) => callStep("human_test", orderId),
);

const qa = task(
  { name: "qa", timeoutSeconds: 900, retry: { maxRetries: 1, waitDurationMs: 5000 } },
  (orderId: string) => callStep("qa", orderId),
);

const deploy = task(
  { name: "deploy", timeoutSeconds: 300, retry: { maxRetries: 2, waitDurationMs: 2000 } },
  (orderId: string) => callStep("deploy", orderId),
);

/** Retrying would double-text the customer. */
const notify = task(
  { name: "notify", timeoutSeconds: 120 },
  (orderId: string) => callStep("notify", orderId),
);

/** The whole order, start to finish. This is the task the API triggers. */
export const runOrder = task(
  { name: "runOrder", timeoutSeconds: 3600 },
  async (orderId: string) => {
    const designed = await designCopy(orderId);
    const built = await build(orderId);
    const tested = await humanTest(orderId);
    const checked = await qa(orderId);
    const deployed = await deploy(orderId);
    const notified = await notify(orderId);
    return { orderId, designed, built, tested, checked, deployed, notified };
  },
);

export { designCopy, build, humanTest, qa, deploy, notify };
