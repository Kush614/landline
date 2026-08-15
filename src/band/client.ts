import { config, has } from "../config.js";
import { req, softly } from "../http.js";
import { logDecision, type Agent } from "../log.js";

export interface BandMessage {
  id: string;
  thread: string;
  from: Agent;
  mentions: Agent[];
  type: string;
  body: string;
  data?: unknown;
  ts: number;
}

/**
 * In-process mirror of the room. Every message is posted to real Band when a key is
 * configured; the mirror is what our own agents block on, so waits work identically
 * whether Band's WebSocket is reachable or not. BAND_ENABLED=false disables BOTH,
 * which is the kill-switch the pipeline is designed to fail on (§7.8).
 */
const mirror: BandMessage[] = [];
const waiters: { match: (m: BandMessage) => boolean; resolve: (m: BandMessage) => void }[] = [];

export class BandDisabledError extends Error {
  constructor(what: string) {
    super(`Band is disabled — ${what} cannot proceed. Set BAND_ENABLED=true.`);
  }
}

function deliver(msg: BandMessage) {
  mirror.push(msg);
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (waiters[i].match(msg)) {
      waiters[i].resolve(msg);
      waiters.splice(i, 1);
    }
  }
}

let seq = 0;

export async function post(opts: {
  thread: string;
  from: Agent;
  mentions?: Agent[];
  type: string;
  body: string;
  data?: unknown;
  orderId?: string;
}): Promise<BandMessage> {
  if (!config.band.enabled) throw new BandDisabledError(`${opts.from} posting "${opts.type}"`);

  const msg: BandMessage = {
    id: `bm_${++seq}_${opts.thread}`,
    thread: opts.thread,
    from: opts.from,
    mentions: opts.mentions ?? [],
    type: opts.type,
    body: opts.body,
    data: opts.data,
    ts: Date.now(),
  };

  if (has.band() && config.band.roomId) {
    const mentionStr = msg.mentions.map((m) => `@${m}`).join(" ");
    await softly(
      "band.post",
      () =>
        req(`${config.band.baseUrl}/chats/${config.band.roomId}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "X-API-Key": config.band.apiKey },
          body: JSON.stringify({ content: `${mentionStr} [${opts.thread}] ${opts.from}/${opts.type}: ${opts.body}` }),
        }),
      undefined,
      opts.orderId,
    );
  }

  deliver(msg);
  logDecision({ agent: opts.from, type: `band:${opts.type}`, orderId: opts.orderId, output: opts.body });
  return msg;
}

/**
 * Block until a matching message lands in the thread. This is a real wait on another
 * agent's post — not a local variable read (§3.3.1).
 */
export function waitFor(
  match: (m: BandMessage) => boolean,
  timeoutMs = 45_000,
): Promise<BandMessage> {
  if (!config.band.enabled) return Promise.reject(new BandDisabledError("waiting for a teammate"));

  const existing = mirror.find(match);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const entry = { match, resolve };
    waiters.push(entry);
    setTimeout(() => {
      const i = waiters.indexOf(entry);
      if (i >= 0) {
        waiters.splice(i, 1);
        reject(new Error("Band wait timed out"));
      }
    }, timeoutMs);
  });
}

export const threadMessages = (thread: string) => mirror.filter((m) => m.thread === thread);
export const latest = (thread: string, type: string) =>
  [...mirror].reverse().find((m) => m.thread === thread && m.type === type);

/** Adds a specialist to the room mid-run (§3.3.3). */
export async function addParticipant(agent: Agent, thread: string, orderId?: string) {
  if (has.band() && config.band.roomId) {
    await softly(
      "band.addParticipant",
      () =>
        req(`${config.band.baseUrl}/chats/${config.band.roomId}/participants`, {
          method: "POST",
          headers: { "content-type": "application/json", "X-API-Key": config.band.apiKey },
          body: JSON.stringify({ agent_name: agent }),
        }),
      undefined,
      orderId,
    );
  }
  logDecision({
    agent: "ceo",
    type: "specialist_added",
    orderId,
    bandDependency: "runtime_specialist",
    output: `${agent} added to ${thread}`,
  });
}

/** Test seam: clear the mirror between smoke tests. */
export function __reset() {
  mirror.length = 0;
  waiters.length = 0;
}
