# DEMO.md — run this cold

Everything the person pitching needs. You should be able to read this once and deliver it without looking at the code.

**The one-liner:** *A landing-page agency that lives inside a phone number. Text it a description, get a live, human-tested, QA-certified site back. No human on our side ever touches it.*

---

## T-20 minutes: preflight

Run these in order. If any line is wrong, the fallback column tells you what you'll say instead.

```bash
curl -s $BASE_URL/health | jq '{sponsors_live, orchestration, terac_degraded, summary}'
curl -s $BASE_URL/api/dashboard | jq '{sites_shipped, seeded_sites_shipped, human_votes, humans_overrode_model}'
npm run seed-demo          # only if the dashboard is empty — see "Seeding" below
```

| Check | Want to see | If it's wrong |
|---|---|---|
| `sponsors_live` | as many `LIVE` as possible | Fine. Each fallback has a line below — the story is *"it degrades, it doesn't die."* |
| `orchestration` | `render-workflow` | `in-process` still works; don't claim the Workflow if it says in-process. |
| `terac_degraded` | `false` | If `true`, you have no fresh human data — lean on seeded study results and say so. |
| `humans_overrode_model` | ≥ 1 | If 0, the "humans overrode the model" beat is dead. Skip it, don't fake it. |

**Tabs to have open, left to right, in this order:**

1. `$BASE_URL/` — the storefront. Good page to be sitting on when you start.
2. iMessage conversation with the LANDLINE number (full screen, big text)
3. Band room `landline-hq`
4. `$BASE_URL/study/<a seeded order id>` — the panelist page
5. Replay QA dashboard — project `landline`
6. Render dashboard → **landline-api** → deploys/logs
7. The Lovable revenue dashboard
8. Stripe dashboard → Payments
9. `$BASE_URL/health` — the sponsor LIVE/FALLBACK list

Have `tail -f logs/decisions.jsonl` running in a terminal you can flip to.

---

## Seeding

```bash
npm run seed-demo
```

Runs four canned orders through the **real** pipeline — real agents, real QA, real screenshots, real deploys. Three go live, one is vetoed by Compliance. Takes about 40 seconds.

Two things make seeded data honest, and **say both out loud if anyone asks**:

- Every seeded order is `is_seed = 1` and is excluded from every headline number on the dashboard. `sites_shipped` counts real customers only; `seeded_sites_shipped` is reported separately.
- Seeded orders use `+1 555 01xx`, the reserved-for-fiction range. The Linq client refuses to text those numbers, so nothing is ever sent to a real person.

Never claim seeded pages as revenue. `revenue_cents` comes from Stripe and nowhere else.

---

## The 90-second script

Timings are cumulative. Practise once — the pipeline takes 60–90s end to end, so **you talk over the wait**, you don't stand in silence.

### 0:00 — the ask (10s)
> "This is a landing-page agency. It has no employees. Its entire storefront is a phone number. Text it what you want and it builds you a site. Someone give me a business."

Take a real brief from a judge. Type it into iMessage. Send.

**Typing indicator appears.** Point at it: *"That's it working."*

### 0:10 — the room (20s)
Flip to **Band**.

> "Six agents just woke up in a shared room. The CEO posted the brief. The Designer is sizing it. Watch Sales — it *can't* quote a price until the Designer's estimate lands in this room. That's not a variable in my code, it's a real wait on a real message. And Compliance can veto anything before it ships."

If the brief was e-commerce, point at the E-com Specialist:
> "That agent didn't exist ten seconds ago. The CEO decided this was a commerce brief and recruited it at runtime — and the Designer changed the layout because of what it posted."

### 0:30 — humans (20s)
Flip to the **study page**.

> "It built three versions. Before anyone sees this, we put it in front of real people through Terac — the general population, not us. Which would you click, which headline is clearest, would you pay nine dollars."

Then the number that matters:
> "On **X% of pages so far, the humans overrode the model's pick.** The model was wrong and strangers told us. We redeploy the human winner and text the customer to say why."

*(Get X from `human_override_rate` on the dashboard before you start.)*

### 0:50 — QA (15s)
Flip to **Replay**.

> "Then Replay QA's it like a user. If it finds a broken call-to-action, that doesn't go to a patch script — it goes back to the **Copywriter agent**, which re-writes the button text, and we re-render. Loops up to three times. Only then can the CEO mark it live."

### 1:05 — delivery and money (15s)
Back to **iMessage**. The card/message is there: live URL, price, pay.

> "Live page, QA-certified, priced by complexity."

Judge taps **Pay** → Apple Pay sheet → flip to **Stripe** and show the charge land.

### 1:20 — revision (10s)
> "Now watch the part nobody else does."

Text: **`make it darker`**

> "That resumed the customer's own virtual machine — paused since we built their site, resumed with their files still on disk — edited it, and redeployed. Every customer has their own sandbox that sleeps between conversations."

### 1:30 — close
Flip to the **dashboard**.

> "Zero employees. $X from people in this room today. Every one of those pages was tested by strangers before the customer saw it — and it got better every hour because those strangers kept telling it what to fix."

---

## Exact texts to send

Use these; they're the ones that have been exercised.

| Text | What it demonstrates |
|---|---|
| `a landing page for Fernway, a small-batch coffee roaster in Oakland that sells subscription bags` | Full pipeline, e-commerce branch, pricing block, top tier |
| `make it darker` | Revision, VM resume, redeploy |
| `change the button to Shop beans` | Revision, copy edit |
| `PAY` | Agent Pay connect flow |
| `a supplement that cures anxiety` | **Compliance veto** — declined politely, never built |
| `cool` | The brief gate — answered, not built into a site called "cool" |
| 👍 tapback on a live page | Tapback → pay prompt |

**Don't** text a two-word business idea and expect a site — the gate will (correctly) ask for more detail. That's a feature; if it happens, say so and add a sentence.

---

## When a fallback fires — what to say

Every integration degrades instead of dying. That's a design decision, and it's a *better* story than pretending everything is up. Check `/health` for which are `FALLBACK`.

| Fallback | What you say |
|---|---|
| **Terac down / no human data** | *"Human testing is asynchronous — we ship the model's pick immediately and upgrade the page when the panel comes back. Here's an order where exactly that happened."* Show a seeded order with votes. |
| **Replay down** | *"QA falls back to our own static checks — dangling CTAs, missing viewport, images without alt text. The CTA→Copywriter handoff still fires."* Show it in `decisions.jsonl`. |
| **Superserve down** | *"Builds fall back to local. The output is byte-identical because rendering is pure — same spec in, same HTML out."* |
| **Pioneer down** | *"Copy falls back to a deterministic template and the PII scrub falls back to regex. We never store an unscrubbed brief."* |
| **Linq down** | Worst case. Drive it via curl against the webhook (see below) and narrate. *"Same pipeline, same agents — the only difference is who's carrying the message."* |
| **Stripe link missing** | Don't demo payment. Say *"payments are one link, submitted to organisers this morning"* and move on. |
| **Render Workflow not running** | Do **not** claim the Workflow. Say *"the pipeline is six registered tasks; right now it's running in-process because <reason>."* Show `render.yaml` and `src/pipeline/workflow.ts`. |
| **Band disabled** | This one you *want* to show deliberately — see the kill-switch below. |

### If Linq is dead, drive the demo by curl

```bash
curl -X POST $BASE_URL/webhooks/linq -H 'content-type: application/json' \
  -d '{"data":{"chat_id":"demo","from":"+14155550001","parts":[{"type":"text","value":"YOUR BRIEF HERE"}]}}'
```

Then show `logs/decisions.jsonl`, the Band room, and the live page. Everything works except the iMessage surface.

---

## The Band kill-switch (30 seconds, worth showing)

Judges for the Band track explicitly check that removing Band breaks the product. Show it:

```bash
BAND_ENABLED=false npx tsx src/server.ts
# then text a brief
```

> "With the room switched off, the CEO can't open a thread, so it refuses the order and tells the customer we're offline. Sales never quotes, because the Designer's estimate never lands. The company stops. That's the dependency being real."

Turn it back on before continuing.

---

## Questions you should have an answer ready for

**"Are those Render Static Sites?"**
> "No — the web service that serves every customer page is on Render, and Render Workflows runs the whole pipeline. We serve pages from the web service rather than creating a static site per customer, because static sites deploy from a git repo and that's 3–5 minutes per order we don't have."

**"How do I know a human really tested it?"**
> Open the study page, then `terac_studies_with_human_data` on the dashboard. *"That's the count of studies with actual votes behind them. If it were below the study count, we'd be shipping blind, and we'd tell you."*

**"Is this revenue real?"**
> "`revenue_cents` comes from Stripe's API with a read-only key, and the dashboard reports `revenue_mode` next to it — `live` or `test`. Seeded demo orders are flagged in the database and excluded from every number on this page."

**If `revenue_mode` is `test`, say so before anyone asks:**
> "Our live Stripe account went into a 2–3 day identity review this afternoon, so payments are running in test mode. The flow is identical and the charge is real in Stripe's sandbox — but that number is not money, and we're not claiming it is."


**"What stops it building something awful?"**
> The Compliance agent. Text it `a supplement that cures anxiety` live and let it decline.

**"What if two people text at once?"**
> "Each order gets its own Band thread, its own VM, and its own workflow run. They don't share state."

---

## Post-demo, before submitting (6:15, not 6:44)

- [ ] `npm run test:all` green, output screenshotted
- [ ] `/health` screenshotted with the sponsor LIVE/FALLBACK list
- [ ] Terac before/after numbers screenshotted (model pick vs human pick)
- [ ] Replay clean report saved; any false positives filed in `logs/replay-false-positives.md`
- [ ] Band kill-switch recorded
- [ ] Render Workflow run history screenshotted
- [ ] Superserve pause/resume visible in `decisions.jsonl` (`vm_paused` → `vm_resumed`)
- [ ] `decisions.jsonl` grepped for the Band dependencies:
      `grep -o '"bandDependency":"[a-z_]*"' logs/decisions.jsonl | sort | uniq -c`

      Expect `sales_blocks_on_designer`, `compliance_veto`, `runtime_specialist`.
      **`qa_changes_copywriter` only appears when QA actually finds a broken CTA**,
      and our generated pages are clean, so it usually won't be in the log. Don't
      claim it from this grep. The reproducible proof is `npm test` section 4, which
      feeds QA a page with a dangling anchor and asserts the Copywriter re-emits the
      CTA — screenshot that output instead.
- [ ] Repo public, 90s video recorded, dashboard URL in the form
