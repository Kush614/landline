import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const DATA_DIR = process.env.DATA_DIR ?? resolve(process.cwd(), "data");
mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(resolve(DATA_DIR, "landline.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  chat_id TEXT,
  brief TEXT NOT NULL,
  brief_scrubbed TEXT,
  tier TEXT DEFAULT 'starter',
  complexity TEXT,
  status TEXT NOT NULL DEFAULT 'intake',
  slug TEXT UNIQUE,
  deploy_url TEXT,
  superserve_vm_id TEXT,
  band_thread_id TEXT,
  compliance TEXT DEFAULT 'pending',
  compliance_reason TEXT,
  winner_idx INTEGER,
  qa_status TEXT,
  stripe_paid INTEGER DEFAULT 0,
  amount_cents INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS variants (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  label TEXT,
  html_path TEXT,
  preview_url TEXT,
  terac_score REAL,
  replay_status TEXT
);

CREATE TABLE IF NOT EXISTS studies (
  id TEXT PRIMARY KEY,
  order_id TEXT,
  terac_study_id TEXT,
  question TEXT,
  results_json TEXT,
  winner_variant_id TEXT,
  model_pick_variant_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT,
  agent TEXT,
  type TEXT,
  payload_json TEXT,
  ts TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  variant_idx INTEGER NOT NULL,
  clearest_idx INTEGER,
  trust INTEGER,
  would_pay INTEGER,
  comment TEXT,
  voter TEXT,
  ts TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_votes_order ON votes(order_id);
CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders(phone);
CREATE INDEX IF NOT EXISTS idx_variants_order ON variants(order_id);
`);

export interface Order {
  id: string;
  phone: string;
  chat_id: string | null;
  brief: string;
  brief_scrubbed: string | null;
  tier: string;
  complexity: string | null;
  status: string;
  slug: string | null;
  deploy_url: string | null;
  superserve_vm_id: string | null;
  band_thread_id: string | null;
  compliance: string;
  compliance_reason: string | null;
  winner_idx: number | null;
  qa_status: string | null;
  stripe_paid: number;
  amount_cents: number;
  created_at: string;
  updated_at: string;
}

export interface Variant {
  id: string;
  order_id: string;
  idx: number;
  label: string | null;
  html_path: string | null;
  preview_url: string | null;
  terac_score: number | null;
  replay_status: string | null;
}

const now = () => new Date().toISOString();

export function createOrder(o: { id: string; phone: string; brief: string; slug: string; chatId?: string }): Order {
  db.prepare(
    `INSERT INTO orders (id, phone, chat_id, brief, slug, created_at, updated_at)
     VALUES (@id, @phone, @chat_id, @brief, @slug, @ts, @ts)`,
  ).run({ id: o.id, phone: o.phone, chat_id: o.chatId ?? null, brief: o.brief, slug: o.slug, ts: now() });
  return getOrder(o.id)!;
}

export const getOrder = (id: string) =>
  db.prepare(`SELECT * FROM orders WHERE id = ?`).get(id) as Order | undefined;

/** Revisions arrive as a plain text from a number we've seen — find their last order. */
export const latestOrderForPhone = (phone: string) =>
  db.prepare(`SELECT * FROM orders WHERE phone = ? ORDER BY created_at DESC LIMIT 1`).get(phone) as
    | Order
    | undefined;

export function updateOrder(id: string, patch: Partial<Order>) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE orders SET ${sets}, updated_at = @updated_at WHERE id = @id`).run({
    ...patch,
    id,
    updated_at: now(),
  });
}

export function upsertVariant(v: Variant) {
  db.prepare(
    `INSERT INTO variants (id, order_id, idx, label, html_path, preview_url, terac_score, replay_status)
     VALUES (@id, @order_id, @idx, @label, @html_path, @preview_url, @terac_score, @replay_status)
     ON CONFLICT(id) DO UPDATE SET
       label=excluded.label, html_path=excluded.html_path, preview_url=excluded.preview_url,
       terac_score=excluded.terac_score, replay_status=excluded.replay_status`,
  ).run(v);
}

export const variantsFor = (orderId: string) =>
  db.prepare(`SELECT * FROM variants WHERE order_id = ? ORDER BY idx`).all(orderId) as Variant[];

export interface StudyRow {
  id: string;
  order_id: string;
  terac_study_id: string | null;
  question: string;
  results_json: string | null;
  winner_variant_id: string | null;
  model_pick_variant_id: string | null;
  created_at: string;
}

export const latestStudy = (orderId: string) =>
  db
    .prepare(`SELECT * FROM studies WHERE order_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(orderId) as StudyRow | undefined;

export function recordEvent(orderId: string | null, agent: string, type: string, payload: unknown) {
  db.prepare(
    `INSERT INTO events (order_id, agent, type, payload_json, ts) VALUES (?, ?, ?, ?, ?)`,
  ).run(orderId, agent, type, JSON.stringify(payload ?? null), now());
}

export interface Vote {
  order_id: string;
  variant_idx: number;
  clearest_idx: number | null;
  trust: number | null;
  would_pay: number | null;
  comment: string | null;
  voter: string | null;
}

export function recordVote(v: Vote) {
  db.prepare(
    `INSERT INTO votes (order_id, variant_idx, clearest_idx, trust, would_pay, comment, voter, ts)
     VALUES (@order_id, @variant_idx, @clearest_idx, @trust, @would_pay, @comment, @voter, @ts)`,
  ).run({ ...v, ts: now() });
}

export const votesFor = (orderId: string) =>
  db.prepare(`SELECT * FROM votes WHERE order_id = ?`).all(orderId) as (Vote & { ts: string })[];

/** Pricing meta-study (§5.1 q5): would-pay rate across every study we've run. */
export function wouldPayStats() {
  const row = db
    .prepare(`SELECT COUNT(*) AS n, SUM(would_pay) AS yes FROM votes WHERE would_pay IS NOT NULL`)
    .get() as { n: number; yes: number | null };
  return { n: row.n ?? 0, yes: row.yes ?? 0 };
}

export function saveStudy(row: {
  id: string;
  orderId: string;
  teracStudyId: string | null;
  question: string;
  results: unknown;
  winnerVariantId: string | null;
  modelPickVariantId: string | null;
}) {
  db.prepare(
    `INSERT INTO studies (id, order_id, terac_study_id, question, results_json, winner_variant_id, model_pick_variant_id, created_at)
     VALUES (@id, @order_id, @terac_study_id, @question, @results_json, @winner_variant_id, @model_pick_variant_id, @ts)
     ON CONFLICT(id) DO UPDATE SET
       results_json=excluded.results_json, winner_variant_id=excluded.winner_variant_id`,
  ).run({
    id: row.id,
    order_id: row.orderId,
    terac_study_id: row.teracStudyId,
    question: row.question,
    results_json: JSON.stringify(row.results ?? null),
    winner_variant_id: row.winnerVariantId,
    model_pick_variant_id: row.modelPickVariantId,
    ts: now(),
  });
}
