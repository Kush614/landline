import type { Agent } from "../log.js";

export interface BandAgent {
  id: string;
  key: string;
  handle: string;
}

/**
 * Band charges per registered remote agent, and the free tier caps out well below
 * our six roles. So each role that *has* its own Band identity posts as itself; the
 * rest post through the CEO's key with an explicit `[role]` prefix, which keeps the
 * transcript honest about who said what instead of silently attributing everything
 * to one bot.
 *
 * BAND_AGENTS is a JSON map: {"ceo":{"id":"…","key":"…","handle":"owner/name"}, …}
 */
let cache: Record<string, BandAgent> | null = null;

export function registry(): Record<string, BandAgent> {
  if (cache) return cache;
  const raw = process.env.BAND_AGENTS;
  if (!raw) return (cache = {});
  try {
    cache = JSON.parse(raw) as Record<string, BandAgent>;
  } catch {
    console.error("BAND_AGENTS is not valid JSON — Band posts will fall back to the CEO key.");
    cache = {};
  }
  return cache;
}

export const agentFor = (name: Agent): BandAgent | undefined => registry()[name];

/** The key we post with, and whether it's really that agent or the CEO speaking for it. */
export function speakerFor(name: Agent): { key: string; asSelf: boolean; handle?: string } | null {
  const own = agentFor(name);
  if (own?.key) return { key: own.key, asSelf: true, handle: own.handle };
  const ceo = agentFor("ceo");
  if (ceo?.key) return { key: ceo.key, asSelf: false, handle: ceo.handle };
  return null;
}

/**
 * Band rejects a message with zero mentions, and rejects mentioning yourself. Resolve
 * the intended mentions to registered handles, drop the speaker, and fall back to any
 * other registered agent so a post never fails validation on an empty list.
 */
export function resolveMentions(from: Agent, mentions: Agent[]): { handle: string }[] {
  const reg = registry();
  const speaker = (agentFor(from) ?? agentFor("ceo"))?.handle;

  const resolved = mentions
    .map((m) => reg[m]?.handle)
    .filter((h): h is string => !!h && h !== speaker);

  if (resolved.length) return [...new Set(resolved)].map((handle) => ({ handle }));

  const anyOther = Object.values(reg)
    .map((a) => a.handle)
    .find((h) => h !== speaker);
  return anyOther ? [{ handle: anyOther }] : [];
}

/** Test seam. */
export function __resetRegistry() {
  cache = null;
}
