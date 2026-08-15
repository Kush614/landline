import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { config, has } from "../config.js";
import { req, softly } from "../http.js";
import { logDecision } from "../log.js";
import type { Order } from "../db.js";

export interface Bug {
  id?: string;
  title: string;
  detail?: string;
  severity?: string;
}

export interface QaReport {
  status: "CLEAN" | "BUGS" | "TIMEOUT";
  bugs: Bug[];
  ctaBroken: boolean;
  /** "replay" when the hosted QA ran; "static" when we fell back to local checks. */
  source: "replay" | "static";
  projectId: string | null;
  dashboardUrl?: string;
}

const headers = () => ({
  "content-type": "application/json",
  Authorization: `Bearer ${config.replay.apiKey}`,
});

const QA_WAIT_MS = Number(process.env.REPLAY_WAIT_MS ?? 180_000);
const POLL_MS = 10_000;

/** Local sanity checks — cheap, instant, and they catch the CTA class of bug. */
export function staticChecks(html: string): Bug[] {
  const bugs: Bug[] = [];
  const anchors = [...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>/g)].map((m) => m[1]);
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

  for (const href of anchors) {
    if (!href || href === "#") bugs.push({ title: "CTA link has no destination", severity: "high" });
    else if (href.startsWith("#") && !ids.has(href.slice(1)))
      bugs.push({ title: `CTA anchor ${href} points at a section that does not exist`, severity: "high" });
  }
  if (!/<title>[^<]{3,}/.test(html)) bugs.push({ title: "Missing page title", severity: "medium" });
  if (!/name="viewport"/.test(html)) bugs.push({ title: "Missing mobile viewport meta", severity: "high" });
  if (/<img\b(?![^>]*\balt=)/.test(html)) bugs.push({ title: "Image without alt text", severity: "medium" });
  return bugs;
}

const isCtaBug = (b: Bug) => /\b(cta|button|link|href|anchor|click|navigat)/i.test(`${b.title} ${b.detail ?? ""}`);

/**
 * Replay QA (§5.4). Creates a project against the live preview URL, polls until the
 * exploration settles, and returns the bug list. Falls back to static checks so the
 * pipeline still has a QA signal when Replay is unavailable.
 */
export async function runQa(order: Order, targetUrl: string, attempt: number, html: string): Promise<QaReport> {
  /** Local checks are the QA signal whenever Replay can't give us one. */
  const staticReport = (): QaReport => {
    const bugs = staticChecks(html);
    logDecision({
      agent: "qa",
      type: bugs.length ? "qa_bugs_static" : "qa_clean_static",
      orderId: order.id,
      output: { attempt, titles: bugs.map((b) => b.title) },
    });
    return {
      status: bugs.length ? "BUGS" : "CLEAN",
      bugs,
      ctaBroken: bugs.some(isCtaBug),
      source: "static",
      projectId: null,
    };
  };

  if (!has.replay()) return staticReport();

  const project = await softly(
    "replay.createProject",
    () =>
      req<{ id: string; dashboard_url?: string; exploration_id?: string }>(`${config.replay.baseUrl}/projects`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          name: `landline ${order.slug} #${attempt}`,
          target_url: targetUrl,
        }),
      }),
    null,
    order.id,
  );

  if (!project?.id) return staticReport();

  logDecision({
    agent: "qa",
    type: "qa_started",
    orderId: order.id,
    input: targetUrl,
    output: { projectId: project.id, attempt },
  });

  const deadline = Date.now() + QA_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));

    const status = await softly<any>(
      "replay.status",
      () => req(`${config.replay.baseUrl}/projects/${project.id}/status`, { headers: headers() }),
      null,
      order.id,
    );
    if (!status) continue;

    const done =
      status.status === "completed" ||
      status.state === "completed" ||
      (status.test_runs?.completed ?? 0) > 0 ||
      (status.explorations?.completed ?? 0) > 0;
    if (!done) continue;

    const bugsRes = await softly<any>(
      "replay.bugs",
      () => req(`${config.replay.baseUrl}/projects/${project.id}/bugs`, { headers: headers() }),
      { items: [] },
      order.id,
    );
    const raw: any[] = bugsRes?.items ?? bugsRes?.bugs ?? bugsRes?.data ?? [];
    const open = raw.filter((b) => (b.status ?? "open") === "open");
    const bugs: Bug[] = open.map((b) => ({
      id: b.id,
      title: b.title ?? b.summary ?? "Issue",
      detail: b.description ?? b.root_cause ?? undefined,
      severity: b.severity,
    }));
    // Replay explores behaviour; our static pass catches markup faults it ignores.
    bugs.push(...staticChecks(html));

    const report: QaReport = {
      status: bugs.length ? "BUGS" : "CLEAN",
      bugs,
      ctaBroken: bugs.some(isCtaBug),
      source: "replay",
      projectId: project.id,
      dashboardUrl: project.dashboard_url,
    };
    logDecision({
      agent: "qa",
      type: bugs.length ? "qa_bugs" : "qa_clean",
      orderId: order.id,
      output: { attempt, count: bugs.length, titles: bugs.map((b) => b.title) },
    });
    return report;
  }

  logDecision({ agent: "qa", type: "qa_timeout", orderId: order.id, output: `${QA_WAIT_MS}ms` });
  return { ...staticReport(), status: "TIMEOUT", projectId: project.id };
}

/** Tell Replay a bug is fixed so it re-runs the journey (§5.4). */
export async function markFixed(bugId: string, orderId?: string) {
  if (!has.replay() || !bugId) return;
  await softly(
    "replay.markFixed",
    () =>
      req(`${config.replay.baseUrl}/bugs/${bugId}`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ status: "fixed" }),
      }),
    undefined,
    orderId,
  );
}

/** Side quest: $50 per reported false positive (§5.4). */
export function logFalsePositive(bug: Bug, why: string) {
  const line = `\n## ${new Date().toISOString()} — ${bug.title}\n\n- Bug id: ${bug.id ?? "n/a"}\n- Replay said: ${bug.detail ?? bug.title}\n- Why it's a false positive: ${why}\n`;
  appendFileSync(resolve(process.cwd(), "logs/replay-false-positives.md"), line);
}
