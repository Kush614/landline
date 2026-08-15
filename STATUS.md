# LANDLINE — STATUS

Last updated: P1 + Render Workflows + Agent Pay + screenshots + demo mode.
`npm test` → **67 passed, 0 failed, 3 skipped** · `npm run test:integration` → **16 passed, 0 failed**.

**Pitching? Read [DEMO.md](./DEMO.md), not this file.**

## Where we are

| Phase | State | Notes |
|---|---|---|
| P0 Setup | ⚠️ **blocked on human** | Repo skeleton, `.env.example`, health endpoint all done. All sponsor signups/keys outstanding — see "What I need from you". |
| P1 Thin loop | ✅ **done** | Text → 3 variants → QA → published page → reply with URL + price. Runs end to end with zero API keys. |
| P2 Superserve + 3 variants | 🟡 code done, unverified | 3 variants + per-order VM + pause/resume + **headless screenshots in the VM**. Falls back to local build + local Playwright. Needs `SUPERSERVE_API_KEY` to prove. |
| P3 Terac | 🟡 code done, unverified | Study launch + poll + winner + 12-min fallback + background upgrade. Needs `TERAC_API_KEY` and enum verification (below). |
| P4 Replay QA | 🟡 code done, unverified | Project create → poll → bugs → fix → re-run, max 3. Static-check fallback works today. Needs `REPLAY_API_KEY`. |
| P5 Band | ✅ all 4 dependencies real | Kill-switch verified by test. Real-API posting needs `BAND_API_KEY` + `BAND_ROOM_ID`. |
| P6 Linq polish | 🟡 mostly | Send, webhook + signature verify, typing, tapback, **Agent Pay (all 4 endpoints, 18 assertions vs a mock)** done. **iMessage App card still missing** — Linq publishes no schema for it. |
| P7 Pioneer + Render Workflows | ✅ **code done** | Pipeline decomposed into 6 tasks in `src/pipeline/workflow.ts` + `render.yaml`. Pioneer copy + GLiNER2-PII wired with fallbacks. Needs a Render deploy to show run history. |
| P8 Sell + light integrations | 🟡 partial | Dashboard JSON live at `/api/dashboard` (documented below); **`npm run seed-demo`** fills it with real pipeline runs. Lovable page is the human's job. |
| P9 Freeze + submit | ⬜ not started | |

## Agent Pay — the customer-facing flow

Apple Pay inside the thread, settling to our Stripe account. Connecting a handle is a two-step dance that spans several inbound texts, so the pending state lives in `payment_connections`:

1. We ship the page and send the price. If the handle isn't connected yet, we follow with: *"To pay with Apple Pay right here, text me back the 6-digit code Linq just sent you."*
2. Customer texts `482913`. The webhook recognises a bare 6-digit number from a mid-connect handle **before** the revision and new-brief branches, so a code is never mistaken for a brief.
3. Verified → we create the payment and reply with the Apple Pay handoff link.
4. Texting `PAY` at any point re-requests a code or re-sends the pay link. A 👍 tapback on a live page also triggers the pay instruction.

`payInstruction()` is the single place that decides the rail: Agent Pay if the handle is connected, Stripe link otherwise, and Stripe link again if Linq is unreachable. **A customer is never left without a way to pay.**

## What works right now, with no keys at all

```bash
npm install && npm run test:all  # 67 unit + 16 integration assertions
npm run seed-demo                # fill the dashboard with real pipeline runs
npx tsx src/server.ts            # then POST a fake brief:
curl -X POST localhost:3777/webhooks/linq -H 'content-type: application/json' \
  -d '{"data":{"chat_id":"c1","from":"+14155550001","parts":[{"type":"text","value":"a landing page for Fernway, a small-batch coffee roaster in Oakland"}]}}'
```

Produces three real pages at `/s/<slug>/v0..v2`, QA's the winner, publishes it at `/s/<slug>`, and logs every agent decision to `logs/decisions.jsonl`. A follow-up text like `make it darker` revises the same order.

## The four Band dependencies (§3.3) — all real, all logged

Every one writes a `bandDependency` field into `logs/decisions.jsonl`, so they're greppable for judging.

1. **Sales blocks on Designer** — `agents/sales.ts` awaits `band.waitFor(designer/complexity_estimate)` before it can price. Test asserts Sales has *not* priced 60ms in, then prices the moment the estimate lands.
2. **Compliance can veto** — `intake()` halts on VETO, texts a decline, never deploys. `"supplement that cures anxiety"` → VETO(medical claim).
3. **Runtime specialist** — an e-commerce brief adds the E-com Specialist to the room mid-run; its `pricing_block` post is what makes the Designer add a pricing section to all three layouts.
4. **QA changes Copywriter** — a flagged CTA routes to the Copywriter, who re-emits the CTA; the page is re-rendered from the new copy rather than patched.

**Kill-switch:** `BAND_ENABLED=false` → `band.post()` and `band.waitFor()` both throw, Sales never prices, and the CEO refuses to open an order. Verified in test §8.

## Render Workflows — what to say to the Render judges

The pipeline is six registered tasks (`designCopy → build → humanTest → qa → deploy → notify`) chained by a `runOrder` task, in `src/pipeline/workflow.ts`, deployed as `type: workflow` in `render.yaml`. **Both** services are on Render: the workflow *and* the web service that hosts the API and serves every customer page. So the honest line is:

> "Render Workflows runs our whole pipeline — six tasks, per-step timeouts and retry policies, full run history in your dashboard. The web service that serves every customer's page is on Render too. We serve those pages from the web service rather than creating a Static Site per customer, because static sites deploy from a git repo and that's 3–5 minutes we don't have per order."

Retry policies encode real constraints, and they're the interesting part:
- `humanTest` — **no retries**. A retry would launch a second paid Terac study.
- `notify` — **no retries**. A retry would double-text the customer.
- `build` — 2 retries with 1.5× backoff (VM creation is the flaky step).
- `deploy` — 2 retries; publishing is idempotent so it's safe.

Each task run gets its own instance with its own filesystem, so tasks don't touch SQLite directly — they call `POST /internal/steps/:step` on the API service, which owns the database, the Band room and the published sites. Every step reloads its own state, so Render's retries are safe and steps are individually re-runnable (verified: re-running `qa` on a live order returns CLEAN again).

`RENDER_WORKFLOW_ENABLED=false` (or a missing key) runs the identical steps in-process, so a Render outage degrades to "slower and less observable", never "no page for the customer".

## Terac degradation is loud, not silent

A wrong `task_type`/`review_type` enum would otherwise ship model-picks all day and leave us with no human evidence for the host's own track. So every Terac failure now:

- prints a 72-character `!!!` banner to stderr naming the consequence and the fix,
- writes a `TERAC_DEGRADED` row to `decisions.jsonl`,
- sets `terac_degraded: true` on **`/health`** with the last alarm,
- sets `terac_degraded` + `terac_alarms` on **`/api/dashboard`**.

A 400/422 on `launchOpportunity` names both suspect env vars in the alarm text. `terac_studies_with_human_data` on the dashboard is the number that actually matters — if it's below `terac_studies_run`, we're shipping blind.

## Screenshots

Every variant gets a PNG at `/s/<slug>/v<idx>.png`, used three ways: the Terac study page (screenshots when present, live iframes when not), the fallback for the iMessage card we don't have a schema for, and the demo.

Two sources, in order. **Headless Chromium inside the customer's Superserve VM** — a second, distinct Superserve use, and it means preview rendering happens in the customer's own sandbox. The PNG comes back base64-encoded because the SDK's `files.read()` returns a string. If the VM has no Chromium, or there's no VM at all, it falls back to **local Playwright**, which works today with no keys. Pages are self-contained single files with inlined CSS, so both paths render identically. Solari would be a drop-in third source.

Never throws: no screenshot just means the study page uses an iframe and the reply is text-only. Set `SHOTS_ENABLED=false` to skip entirely.

## The hero visual

The split layout used to have an empty gradient rectangle where a product shot would
go — the weakest thing on the page. We can't source photography for an arbitrary
business and stock imagery would be worse, so `src/builder/motif.ts` generates an
abstract composition from the page's own palette: inline SVG, no extra request,
renders identically in a screenshot, `aria-hidden` because it's decorative.

Four motifs, chosen by what the business is and falling back to a hash of the brand
so two coffee shops don't get the same page: **stack** (offset cards — shops and
subscriptions), **field** (dot grid + block — technical and software), **overlap**
(two circles with the intersection picked out as a solid lens — food, salons, crafts),
**arcs** (concentric sweeps — the general fallback).

## The brief gate

A phone number is the whole storefront, so anything a stranger types arrives at `intake`. Without a gate, a judge texting "cool" during judging spawns a site called *cool*. `src/agents/intent.ts` classifies every inbound message into `brief | revision | pay | code | chitchat`:

- bare 6-digit numbers → Agent Pay codes, never briefs
- `PAY` → payment flow
- greetings, thanks, yes/no, `?`, bare emoji → answered with a useful reply, never built
- under 4 words with no actionable verb → asked for more detail
- short *and* actionable (`make it darker`) from a customer with a live page → revision

Verified live: `cool`, `thanks!`, `👍`, `ok`, `hi` produce five helpful replies and zero orders.

## Deliberate deviations from the spec

Three, each for a stated reason. Flagging them so they're a decision, not a surprise.

1. **Sites are served from our Render Web Service (`BASE_URL/s/<slug>`), not a Render Static Site per customer.** Render static sites deploy from a git repo — creating a repo and waiting on a build is 3–5 minutes per customer and fails in ways we can't recover from live on stage. Serving from the API is instant and idempotent. Render Workflows still carries the pipeline, so the Render track is satisfied. *Upgrade path: real static sites in P7 if there's time.*
2. **Generated pages use inlined CSS, not the Tailwind play CDN.** Keeps pages at ~6KB, removes a third-party script from the critical path (which Replay QA and a live demo both punish), and keeps Lighthouse a11y high. Same design system, no runtime dependency.
3. **Terac supplies the panel; the comparison page is ours.** Panelists land on `/study/:orderId`, which shows all three live variants in iframes and asks the five §5.1 questions. This keeps the question set exactly as specified regardless of Terac's own question schema, and gives us structured results we control.

## Dashboard feed for the Lovable page

`GET {BASE_URL}/api/dashboard` — CORS-open (`access-control-allow-origin: *`), no auth, safe to poll every 10s. Stripe reads are cached 30s.

```json
{
  "updated_at": "2026-08-15T19:20:39.346Z",
  "revenue_cents": 0,          "revenue_source": "stripe | unconfigured",
  "charges": 0,                "booked_cents": 0,
  "sites_shipped": 0,          "orders_total": 1,
  "orders_declined_by_compliance": 0,
  "terac_studies_run": 1,      "terac_studies_with_human_data": 0,
  "human_votes": 0,            "humans_overrode_model": 0,
  "human_override_rate": 0.0,
  "terac_degraded": false,     "terac_alarms": [],
  "qa_passes": 1,              "agent_decisions": 35,
  "pricing_study": { "asked": 0, "would_pay_9": 0, "rate": 0.0 },
  "sponsors_live": { "linq": false, "stripe": false, "…": false }
}
```

Suggested hero numbers, in the order that tells the story: **`revenue_cents`** (÷100, big) · **`sites_shipped`** · **`human_override_rate`** as "humans overrode the model on X% of pages" · **`pricing_study.rate`** as "X% of testers would pay $9" · **`agent_decisions`** as "decisions made with zero humans". Render `terac_degraded: true` as a visible red banner — that's the flag that says our human-testing evidence is at risk.

Two gotchas: `revenue_cents` stays 0 until `STRIPE_READ_KEY` is set (`revenue_source` tells you which), and `terac_alarms` is in-memory so it clears on restart while the `TERAC_DEGRADED` rows in `decisions.jsonl` persist.

## What I need from you (P0 chores — all blocking)

Roughly in order of how much they unblock:

1. **Stripe** — create the Payment Link ("Customer chooses price") and the `rk_` read key, submit both to organizers. → `STRIPE_PAYMENT_LINK`, `STRIPE_READ_KEY`. *Nothing can take money until this exists.*
2. **Linq** — sandbox signup at linqapp.com/hackathon. → `LINQ_API_KEY`, `LINQ_PHONE_NUMBER`, `LINQ_WEBHOOK_SECRET`. *Nothing is a storefront until this exists.*
3. **Render** — claim credits, deploy this repo as a Web Service, set `BASE_URL` to the live URL. → `RENDER_API_KEY`, `RENDER_OWNER_ID`. *Terac panelists and Replay both need a publicly reachable URL — localhost won't do.*
4. **Terac** — API key. → `TERAC_API_KEY`
5. **Replay** — qa.replay.io, redeem `HACKATHON`. → `REPLAY_API_KEY`
6. **Superserve** — superserve.ai. → `SUPERSERVE_API_KEY`, then `npm i @superserve/sdk`
7. **Pioneer** — agent.pioneer.ai, promo `ZeroHumanHack0826`. → `PIONEER_API_KEY`
8. **Band** — band.ai, code `HACKBANDAUG26`, create room `landline-hq`. → `BAND_API_KEY`, `BAND_AGENT_ID`, `BAND_ROOM_ID`

Drop them in `.env` and everything lights up — `/health` shows which sponsors are live.

## Doc traps

Every one of these cost real time. Written down so nobody on the team pays twice, and so judges can see where their own docs bite.

**Render — the SDK import in the docs does not exist.** The Workflows tutorial shows `import { task } from '@renderinc/sdk'` and references a `@render/sdk` package. `@render/sdk` 404s on npm, and `task`/`startTaskServer` are *not* root exports. The truth, from the installed typings:
```ts
import { task, startTaskServer } from "@renderinc/sdk/workflows"; // not the root
import { Render } from "@renderinc/sdk";                          // client is the root
```
Also: `RegisterTaskOptions` is `{name, timeoutSeconds, plan, retry:{maxRetries, waitDurationMs, backoffScaling}}` — `name` is required, and the task slug is `{workflow-slug}/{task-name}`.

**Render — chained tasks don't share a filesystem or memory.** Each task run gets its own instance. Anything stateful (SQLite, an in-process message bus) has to live behind a service the tasks call, or every step after the first silently sees an empty world. This is why the pipeline is six steps that reload their own state.

**Linq — no links in the first outbound message.** Sandbox rule. Our reply is a URL, so `linq/client.ts` tracks which chats we've already sent into and slips a link-free ack in first. Miss this and your very first customer message is silently rejected.

**Linq — inbound-first.** Agents can't open a conversation; the customer must text the number first. Plan the demo around a judge texting in, not us texting out.

**Linq — payments are only in `llms-full.txt`.** The public quickstart has no payments section at all. The connect/verify/credentials routes came from the LLM bundle; `POST /v3/payments` itself is inferred (the doc showed the body, not the route) and is env-overridable via `LINQ_PAYMENTS_PATH`.

**Terac — the reference lists fields but not enum values.** `task_type` and `review_type` are required and undocumented. Guessing wrong = no human data all day, which is why that failure is now loud (see above).

**Pioneer — two different auth headers in the same docs.** The authentication page says `X-API-Key`; the GLiNER2-PII example uses `Authorization: Bearer`. We send `X-API-Key` (it's the one the auth page and the OpenAPI spec agree on). If PII scrubbing 401s, try the Bearer form before assuming the key is bad.

**Better-sqlite3 + `type: module`.** Needs `import Database from "better-sqlite3"` (default import); the named-import form typechecks under some configs and explodes at runtime.

## Known gaps and risks

- **Terac `task_type` / `review_type` enums are unverified.** Their reference lists the fields but not the allowed values. Both are env-overridable (`TERAC_TASK_TYPE`, `TERAC_REVIEW_TYPE`). A wrong guess now raises a loud alarm rather than failing silently (see above), but it still means no human data. **Ask at the Terac booth — they're the host, it's a one-minute answer. First real study must be launched by 3pm.**
- **Agent Pay is wired but never run against real Linq.** All four endpoints are implemented and covered by 18 assertions against a mock that mimics the documented shapes, so the moment the key lands it either works or fails loudly in one place. Two unknowns remain: the create-payment route is inferred (`LINQ_PAYMENTS_PATH` overrides it) and the `user_token`/`fetch_url` handoff is documented as "for the agent to redeem" without saying how redemption surfaces in iMessage. **Ask Linq both.** Everything soft-fails to the Stripe link, so a wrong guess costs Apple Pay, not the sale.
- **The iMessage App card has no published schema.** If Linq doesn't supply one, fall back to a rich-media message: preview screenshot + status line + pay link. Still demoable, and the screenshot needs Solari or a headless shot from the Superserve VM.
- **Linq sandbox forbids links in the first outbound message.** Handled: `linq/client.ts` sends a link-free ack first and puts the URL in the next message.
- **Render docs are wrong about the SDK import.** Their tutorial shows `import { task } from '@renderinc/sdk'` and a `@render/sdk` package. Neither exists: the package is `@renderinc/sdk` and `task`/`startTaskServer` are exported from **`@renderinc/sdk/workflows`**. Verified against the installed typings, not the docs.
- **Solari not wired.** Screenshots come from headless Chromium in the Superserve VM, falling back to local Playwright. Solari would be a drop-in third source if there's time.
- `logs/replay-false-positives.md` is empty — file any as they show up ($50 each).

## Repo map

```
src/server.ts          Fastify: webhook, hosted sites, study page, dashboard JSON
src/pipeline/run.ts    CEO orchestration — intake, buildAndShip, revise
src/agents/            designer, copywriter, compliance, sales, ecom, pii
src/band/client.ts     room, post, waitFor, kill-switch
src/builder/           render.ts (spec → HTML), edit.ts (revisions), palettes
src/terac/             study.ts (launch/poll/winner), page.ts (panelist page)
src/replay/qa.ts       QA run + static-check fallback
src/superserve/vm.ts   per-order VM, pause/resume
src/deploy/sites.ts    publish, spec persistence
src/dashboard/data.ts  /api/dashboard feed
test/smoke.ts          the §7 acceptance tests
```
