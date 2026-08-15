# LANDLINE — STATUS

Last updated: P1 complete. `npm test` → **49 passed, 0 failed, 3 skipped**.

## Where we are

| Phase | State | Notes |
|---|---|---|
| P0 Setup | ⚠️ **blocked on human** | Repo skeleton, `.env.example`, health endpoint all done. All sponsor signups/keys outstanding — see "What I need from you". |
| P1 Thin loop | ✅ **done** | Text → 3 variants → QA → published page → reply with URL + price. Runs end to end with zero API keys. |
| P2 Superserve + 3 variants | 🟡 code done, unverified | 3 variants + per-order VM + pause/resume all wired. Falls back to local build. Needs `SUPERSERVE_API_KEY` to prove. |
| P3 Terac | 🟡 code done, unverified | Study launch + poll + winner + 12-min fallback + background upgrade. Needs `TERAC_API_KEY` and enum verification (below). |
| P4 Replay QA | 🟡 code done, unverified | Project create → poll → bugs → fix → re-run, max 3. Static-check fallback works today. Needs `REPLAY_API_KEY`. |
| P5 Band | ✅ all 4 dependencies real | Kill-switch verified by test. Real-API posting needs `BAND_API_KEY` + `BAND_ROOM_ID`. |
| P6 Linq polish | 🟡 partial | Send, webhook + signature verify, typing, tapback done. **iMessage App card and Agent Pay not built** — needs docs + key. |
| P7 Pioneer + Render Workflows | 🟡 partial | Pioneer copy + GLiNER2-PII wired with fallbacks. **Render Workflow not yet expressed** — pipeline runs in-process. |
| P8 Sell + light integrations | ⬜ not started | Dashboard JSON is live at `/api/dashboard`; Lovable page not built. |
| P9 Freeze + submit | ⬜ not started | |

## What works right now, with no keys at all

```bash
npm install && npm test          # 49 assertions
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

## Deliberate deviations from the spec

Three, each for a stated reason. Flagging them so they're a decision, not a surprise.

1. **Sites are served from our Render Web Service (`BASE_URL/s/<slug>`), not a Render Static Site per customer.** Render static sites deploy from a git repo — creating a repo and waiting on a build is 3–5 minutes per customer and fails in ways we can't recover from live on stage. Serving from the API is instant and idempotent. Render Workflows still carries the pipeline, so the Render track is satisfied. *Upgrade path: real static sites in P7 if there's time.*
2. **Generated pages use inlined CSS, not the Tailwind play CDN.** Keeps pages at ~6KB, removes a third-party script from the critical path (which Replay QA and a live demo both punish), and keeps Lighthouse a11y high. Same design system, no runtime dependency.
3. **Terac supplies the panel; the comparison page is ours.** Panelists land on `/study/:orderId`, which shows all three live variants in iframes and asks the five §5.1 questions. This keeps the question set exactly as specified regardless of Terac's own question schema, and gives us structured results we control.

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

## Known gaps and risks

- **Terac `task_type` / `review_type` enums are unverified.** Their reference lists the fields but not the allowed values. Both are env-overridable (`TERAC_TASK_TYPE`, `TERAC_REVIEW_TYPE`) and the call is soft-failed, so a wrong guess degrades to the model pick instead of breaking. **Verify against Terac's catalog or ask on Slack before the demo.**
- **Linq iMessage App cards and Agent Pay are undocumented in the public quickstart.** Agent Pay endpoints (`/v3/payments/handles/{handle}/connect|verify`, `POST` payment, `GET /credentials`) came from `llms-full.txt`; the card schema did not appear at all. Ask Linq in Discord.
- **Linq sandbox forbids links in the first outbound message.** Handled: `linq/client.ts` sends a link-free ack first and puts the URL in the next message.
- **Render Workflows not yet used** — the pipeline runs in-process. `@renderinc/sdk` `task()` wrappers around the seven steps is a ~30 min job; it's required for the Render track.
- **No screenshots yet** — the study page uses live iframes instead. Fine, arguably better, but Solari/headless screenshots would look better in the Terac task preview.
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
