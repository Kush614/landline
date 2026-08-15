import { config, has } from "../config.js";
import { req, softly } from "../http.js";
import { logDecision } from "../log.js";
import { votesFor, type Order, type Variant } from "../db.js";

export interface StudyResult {
  studyId: string | null;
  question: string;
  source: "terac" | "model";
  winner: Variant;
  scores: Record<number, number>;
  preference: number;
  results: unknown;
}

export const QUESTION = 'Which of these three would you most likely click "Get started" on?';

const headers = () => ({
  "content-type": "application/json",
  Authorization: `Bearer ${config.terac.apiKey}`,
});

/** How long the pipeline waits inline before shipping the model's pick (§4.4). */
const INLINE_WAIT_MS = Number(process.env.TERAC_INLINE_WAIT_MS ?? 120_000);
const BACKGROUND_WAIT_MS = Number(process.env.TERAC_BACKGROUND_WAIT_MS ?? 12 * 60_000);
const POLL_MS = 8_000;

async function ensureProject(): Promise<string | null> {
  if (config.terac.projectId) return config.terac.projectId;
  return softly(
    "terac.createProject",
    async () => {
      const res = await req<{ id: string }>(`${config.terac.baseUrl}/projects`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ name: "LANDLINE landing-page preference tests" }),
      });
      return res.id ?? null;
    },
    null,
  );
}

/**
 * Terac supplies the humans; the comparison page we host collects the choice.
 * That keeps the question set (§5.1) under our control and gives us structured
 * results regardless of Terac's own question schema.
 */
async function launchOpportunity(order: Order, projectId: string): Promise<string | null> {
  return softly(
    "terac.launchOpportunity",
    async () => {
      const created = await req<{ id: string }>(`${config.terac.baseUrl}/opportunities`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          project_id: projectId,
          title: "Pick the landing page you'd actually click",
          internal_title: `landline ${order.slug}`,
          description:
            "You'll see three versions of the same one-page website. Tell us which one you would click, which headline is clearest, and how much you trust it. Takes about 2 minutes.",
          num_participants: Number(process.env.TERAC_PARTICIPANTS ?? 30),
          business_type: "b2c",
          unrestricted_audience: true,
          expected_days_to_complete: 1,
          tasks: [
            {
              sequence: 1,
              task_type: process.env.TERAC_TASK_TYPE ?? "unmoderated_task",
              review_type: process.env.TERAC_REVIEW_TYPE ?? "auto",
              task_url: `${config.baseUrl}/study/${order.id}`,
              participant_url_template: `${config.baseUrl}/study/${order.id}?p={participant_id}`,
              title: "Compare three landing pages",
              description: "Open each version, then answer five short questions.",
              duration_minutes: 3,
            },
          ],
        }),
      });
      if (!created?.id) return null;

      await req(`${config.terac.baseUrl}/opportunities/${created.id}/launch`, {
        method: "POST",
        headers: headers(),
        body: "{}",
      });
      return created.id;
    },
    null,
  );
}

function tally(orderId: string, variants: Variant[]) {
  const votes = votesFor(orderId);
  const scores: Record<number, number> = {};
  for (const v of variants) scores[v.idx] = 0;
  for (const vote of votes) scores[vote.variant_idx] = (scores[vote.variant_idx] ?? 0) + 1;

  const total = votes.length;
  let bestIdx = variants[0].idx;
  for (const v of variants) if ((scores[v.idx] ?? 0) > (scores[bestIdx] ?? 0)) bestIdx = v.idx;

  return { scores, total, bestIdx, preference: total ? (scores[bestIdx] ?? 0) / total : 0, votes };
}

const MIN_VOTES = Number(process.env.TERAC_MIN_VOTES ?? 3);

export async function runStudy(input: {
  order: Order;
  variants: Variant[];
  modelPick: Variant;
}): Promise<StudyResult> {
  const { order, variants, modelPick } = input;

  const modelResult = (studyId: string | null): StudyResult => ({
    studyId,
    question: QUESTION,
    source: "model",
    winner: modelPick,
    scores: Object.fromEntries(variants.map((v) => [v.idx, 0])),
    preference: 0,
    results: { note: "shipped model pick; human results pending" },
  });

  if (!has.terac()) {
    logDecision({ agent: "ceo", type: "study_skipped", orderId: order.id, output: "no TERAC_API_KEY" });
    return modelResult(null);
  }

  const projectId = await ensureProject();
  const studyId = projectId ? await launchOpportunity(order, projectId) : null;
  logDecision({
    agent: "ceo",
    type: "study_launched",
    orderId: order.id,
    input: `${config.baseUrl}/study/${order.id}`,
    output: { studyId, projectId },
  });

  const deadline = Date.now() + INLINE_WAIT_MS;
  while (Date.now() < deadline) {
    const t = tally(order.id, variants);
    if (t.total >= MIN_VOTES) {
      const winner = variants.find((v) => v.idx === t.bestIdx)!;
      logDecision({
        agent: "ceo",
        type: "human_winner",
        orderId: order.id,
        input: { modelPick: modelPick.idx },
        output: { winner: winner.idx, n: t.total, preference: t.preference },
      });
      return {
        studyId,
        question: QUESTION,
        source: "terac",
        winner,
        scores: t.scores,
        preference: t.preference,
        results: { n: t.total, scores: t.scores },
      };
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  // §4.4 fallback: ship the model's pick now, keep listening, upgrade later.
  logDecision({
    agent: "ceo",
    type: "study_fallback",
    orderId: order.id,
    output: `no human results in ${INLINE_WAIT_MS}ms — shipping model pick, still polling`,
  });
  return modelResult(studyId);
}

/**
 * Keeps polling after we've already shipped. If humans disagree with the model,
 * redeploy the human winner and tell the customer why (§4.4).
 */
export async function watchAndUpgrade(
  order: Order,
  variants: Variant[],
  modelPick: Variant,
  onUpgrade: (winner: Variant, preference: number, n: number) => Promise<void>,
) {
  const deadline = Date.now() + BACKGROUND_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS * 2));
    const t = tally(order.id, variants);
    if (t.total < MIN_VOTES) continue;
    if (t.bestIdx === modelPick.idx) {
      logDecision({
        agent: "ceo",
        type: "humans_agreed",
        orderId: order.id,
        output: { n: t.total, preference: t.preference },
      });
      return;
    }
    const winner = variants.find((v) => v.idx === t.bestIdx)!;
    logDecision({
      agent: "ceo",
      type: "humans_overrode_model",
      orderId: order.id,
      input: { modelPick: modelPick.idx },
      output: { winner: winner.idx, n: t.total, preference: t.preference },
    });
    await onUpgrade(winner, t.preference, t.total);
    return;
  }
}
