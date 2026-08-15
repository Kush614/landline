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

/**
 * Terac degradations are the one class of failure we must never swallow: a bad
 * task_type enum would silently ship model-picks all day and leave us with no human
 * evidence for the host's own track. Every one of these is a loud, greppable alarm.
 */
export const teracAlarms: { at: string; stage: string; detail: string }[] = [];

function alarm(stage: string, detail: string, orderId?: string) {
  const at = new Date().toISOString();
  teracAlarms.push({ at, stage, detail });
  console.error(
    `\n${"!".repeat(72)}\n` +
      `TERAC DEGRADED — ${stage}\n${detail}\n` +
      `Consequence: this order ships the MODEL's pick, with no human preference data.\n` +
      `Fix: verify TERAC_TASK_TYPE / TERAC_REVIEW_TYPE and TERAC_API_KEY at the Terac booth.\n` +
      `${"!".repeat(72)}\n`,
  );
  logDecision({ agent: "ceo", type: "TERAC_DEGRADED", orderId, input: stage, output: detail });
}

async function ensureProject(orderId?: string): Promise<string | null> {
  if (config.terac.projectId) return config.terac.projectId;
  try {
    const res = await req<{ id: string }>(`${config.terac.baseUrl}/projects`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ name: "LANDLINE landing-page preference tests" }),
    });
    if (!res?.id) {
      alarm("createProject", "Terac returned no project id", orderId);
      return null;
    }
    return res.id;
  } catch (err) {
    alarm("createProject", `POST /projects failed: ${err instanceof Error ? err.message : String(err)}`, orderId);
    return null;
  }
}

/**
 * Terac supplies the humans; the comparison page we host collects the choice.
 * That keeps the question set (§5.1) under our control and gives us structured
 * results regardless of Terac's own question schema.
 */
/**
 * Terac charges per participant (~$4.50 at the time of writing), and we launch a
 * study per shipped site. An unattended pipeline that spends real money per inbound
 * text is a foot-gun, so we create the opportunity as a DRAFT first, read the price
 * Terac quotes back, and only launch if it's within budget.
 */
const MAX_COST_CENTS = Number(process.env.TERAC_MAX_COST_CENTS ?? 2500);

async function launchOpportunity(order: Order, projectId: string): Promise<string | null> {
  try {
      const created = await req<{
        id: string;
        pricing?: { total_cost_cents?: number; cost_per_participant_cents?: number };
      }>(`${config.terac.baseUrl}/opportunities`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          project_id: projectId,
          title: "Pick the landing page you'd actually click",
          internal_title: `landline ${order.slug}`,
          description:
            "You'll see three versions of the same one-page website. Tell us which one you would click, which headline is clearest, and how much you trust it. Takes about 2 minutes.",
          // Small on purpose: Terac bills per participant and we run a study per
          // shipped site. Enough for a signal, not enough to burn the budget.
          num_participants: Number(process.env.TERAC_PARTICIPANTS ?? 5),
          business_type: "b2c",
          unrestricted_audience: true,
          expected_days_to_complete: 5, // API minimum
          // Terac refuses to launch an opportunity with no screener (412). Values
          // confirmed against the live API:
          //   pick          = one | any | boolean | text | grid
          //   qualify_logic = may | must | must_one_of | reject | review
          // Deliberately inclusive — we want the general population, and the only
          // people we genuinely can't use are those who never look at these sites.
          screening_questions: [
            {
              key: "visits_small_business_sites",
              text: "How often do you look at the website of a small or local business — a cafe, salon, studio, or tradesperson?",
              pick: "one",
              answers: [
                { text: "At least once a week", qualify_logic: "may", allow_free_text: false },
                { text: "A few times a month", qualify_logic: "may", allow_free_text: false },
                { text: "A few times a year", qualify_logic: "may", allow_free_text: false },
                { text: "Never — I don't visit these sites", qualify_logic: "reject", allow_free_text: false },
              ],
            },
          ],
          tasks: [
            {
              sequence: 1,
              // Enum values confirmed against the live API, not guessed:
              // task_type   = interview | file_upload | activity
              // review_type = auto_approve | manual_review | self_report
              task_type: process.env.TERAC_TASK_TYPE ?? "activity",
              review_type: process.env.TERAC_REVIEW_TYPE ?? "auto_approve",
              task_url: `${config.baseUrl}/study/${order.id}`,
              participant_url_template: `${config.baseUrl}/study/${order.id}?p={participant_id}`,
              title: "Compare three landing pages",
              description: "Open each version, then answer five short questions.",
              duration_minutes: 3,
            },
          ],
        }),
      });
    if (!created?.id) {
      alarm("createOpportunity", "Terac accepted the request but returned no opportunity id", order.id);
      return null;
    }

    // Spend gate. The draft exists either way — a human can launch it from the
    // Terac dashboard — but the pipeline will not spend above the cap on its own.
    const cost = created.pricing?.total_cost_cents ?? 0;
    if (cost > MAX_COST_CENTS) {
      alarm(
        "cost_gate",
        `Terac quoted $${(cost / 100).toFixed(2)} for opportunity ${created.id}, above the $${(MAX_COST_CENTS / 100).toFixed(2)} cap. Draft saved but NOT launched — launch it by hand or raise TERAC_MAX_COST_CENTS.`,
        order.id,
      );
      return null;
    }

    await req(`${config.terac.baseUrl}/opportunities/${created.id}/launch`, {
      method: "POST",
      headers: headers(),
      body: "{}",
    });
    logDecision({
      agent: "ceo",
      type: "terac_launched",
      orderId: order.id,
      output: { id: created.id, costCents: cost, participants: Number(process.env.TERAC_PARTICIPANTS ?? 5) },
    });
    return created.id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // A 4xx here almost certainly means our task_type/review_type guess is wrong.
    const enumHint = /400|422/.test(msg)
      ? ` — check TERAC_TASK_TYPE ("${process.env.TERAC_TASK_TYPE ?? "activity"}") must be interview|file_upload|activity, and TERAC_REVIEW_TYPE ("${process.env.TERAC_REVIEW_TYPE ?? "auto_approve"}") must be auto_approve|manual_review|self_report.`
      : "";
    alarm("launchOpportunity", `${msg}${enumHint}`, order.id);
    return null;
  }
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

  const humanResult = (studyId: string | null): StudyResult | null => {
    const t = tally(order.id, variants);
    if (t.total < MIN_VOTES) return null;
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
  };

  // Votes we already hold win outright, whether or not Terac launched the study —
  // the study link is shareable, so a vote is a vote. This is also what makes a
  // re-run of this step honour a panel that voted after we shipped.
  const already = humanResult(null);
  if (already) return already;

  // Seeded demo orders never spend. They carry synthetic votes already, and a
  // paid panel for a fictional business is money on fire.
  if (order.is_seed) {
    logDecision({ agent: "ceo", type: "study_skipped_seed", orderId: order.id, output: "seeded order — no Terac spend" });
    return modelResult(null);
  }

  if (!has.terac()) {
    alarm("no_api_key", "TERAC_API_KEY is unset — no study will be launched for this order.", order.id);
    return modelResult(null);
  }

  const projectId = await ensureProject(order.id);
  const studyId = projectId ? await launchOpportunity(order, projectId) : null;
  // Even if the launch failed we keep polling: the study link is shareable, and votes
  // from anyone (including the room) are still real human preference data.
  logDecision({
    agent: "ceo",
    type: "study_launched",
    orderId: order.id,
    input: `${config.baseUrl}/study/${order.id}`,
    output: { studyId, projectId },
  });

  const deadline = Date.now() + INLINE_WAIT_MS;
  while (Date.now() < deadline) {
    const result = humanResult(studyId);
    if (result) return result;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  // §4.4 fallback: ship the model's pick now, keep listening, upgrade later.
  alarm(
    "no_results_in_time",
    `Study ${studyId} launched but fewer than ${MIN_VOTES} responses arrived in ${Math.round(INLINE_WAIT_MS / 1000)}s. Still polling in the background for ${Math.round(BACKGROUND_WAIT_MS / 60_000)} min.`,
    order.id,
  );
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
