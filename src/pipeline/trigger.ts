import { config, has } from "../config.js";
import { logDecision } from "../log.js";

/**
 * Hands an order to the Render Workflow. Returns false if we couldn't — the caller
 * then runs the same steps in-process, so a Render outage degrades to "slower and
 * less observable" rather than "no page for the customer".
 */
export async function triggerOrderWorkflow(orderId: string): Promise<boolean> {
  const slug = process.env.RENDER_WORKFLOW_SLUG ?? "landline-pipeline/runOrder";
  if (!has.render()) {
    logDecision({ agent: "ceo", type: "workflow_unavailable", orderId, output: "no RENDER_API_KEY" });
    return false;
  }

  try {
    const { Render } = await import("@renderinc/sdk");
    const client = new Render({ token: config.render.apiKey, ownerId: config.render.ownerId });
    const run = await client.workflows.startTask(slug, [orderId]);
    logDecision({
      agent: "ceo",
      type: "workflow_started",
      orderId,
      input: slug,
      output: { taskRunId: (run as { taskRunId?: string }).taskRunId ?? String(run) },
    });
    return true;
  } catch (err) {
    logDecision({ agent: "ceo", type: "workflow_trigger_failed", orderId, output: String(err) });
    return false;
  }
}
