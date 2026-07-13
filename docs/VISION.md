# stackcanvas — Product Vision: End State

**Status:** definitive merged vision, July 2026 (rev. 2 — review fixes applied). Primary identity taken from Mission Control (the supervision surface), organs stolen from Studio (brownfield adoption, Sunday review, credential broker, audit log) and Stackpilot (CI handoff, policy gates, "ejected-only" HCL honesty). The PaaS ambitions, the daily-dashboard claim, and the incident copilot are staged out or killed per critique consensus.

---

## 1. Продукт одной строкой

**Stackcanvas is the local-first cockpit for agent-driven infrastructure: a live canvas of your real AWS/Terraform estate where you see what exists, review what your AI agent is about to change, and approve every mutation — with credentials that never leave your machine.**

---

## 2. The end product

### Identity

An **agent supervision cockpit**, not a PaaS, not a monitoring platform, not a visual IaC compiler. The one-sentence positioning: every competitor (Brainboard, Spacelift, env0, Flightcontrol, Firefly, Pulumi Neo) asks you to hand prod credentials or your IaC ecosystem to their cloud; stackcanvas runs entirely on your machine and embeds the agent you already pay for. Text is a terrible supervision surface for infrastructure — vendor surveys articulate the pain (Spacelift's 2026 survey reportedly puts AI-caused infra incidents at 93% of orgs; Firefly reportedly finds only 34% would trust autonomous changes). These are vendor-survey numbers: **each is verified against its primary source before it fronts any launch copy (a Stage 1 deliverable); where unverifiable, it ships hedged.** Stackcanvas is the missing monitor and steering wheel for terminal agents, not a competitor to them.

Two product layers, one name:

- **stackcanvas (OSS, MIT, free forever)** — the canvas + constructor + MCP intent loop that exists today. The adoption engine. Works in Claude Code today; Cursor and Windsurf should work as MCP clients but are **untested claims until Stage 1 verifies and documents them**.
- **Stackcanvas Studio (paid desktop tier)** — Tauri app adding the read path (live account scan, drift, fleet view), the Sunday review, guardrails, and the audit log.

### Target user

- **Wedge / free funnel — "Dmytro":** accidental infra owner, founding full-stack engineer at a 1–10 person AWS startup, lives in Claude Code, changes infra ~weekly, reads plans with held breath. The OSS canvas already delivers ~80% of his core job (see the plan, catch the agent's mistake). He stars, evangelizes, and mostly does not pay. Priced at $0 — he is distribution, not revenue.
- **First payer — "Maya/Marcus":** fractional DevOps consultant managing 3–10 client AWS accounts, whose MSAs contractually forbid granting third-party SaaS access to client clouds. This constraint disqualifies the entire competitive field — with one honest caveat: it only *fully* holds if agent context is controlled too, because agent sessions send infra data to the model API (see the data boundary in §4). Whether her MSAs accept "metadata to a model API with redaction," or require the no-LLM mode, is asked verbatim in the Q4 2026 consultant calls. Already pays Hava $99/mo for static read-only diagrams. Least price-sensitive persona; each one demos the product in front of 4+ CTOs.
- **Expansion (v2+) — "Sam":** 25-person post-SOC2 team where policy forbids external SaaS write access; per-engineer desktop with local assumed roles fits the compliance story. Requires shared-review features that don't exist yet — explicitly deferred.
- **Anti-personas:** 50+ eng platform teams (Spacelift's fight), Terraform CLI purists, homelab/Coolify crowd, non-technical founders, and Alex the vibecoder — he bounces the first time the canvas shows a NAT Gateway; chasing him makes the product a worse Flightcontrol.

### The core recurring loop (honest version)

Not "always-open daily map" — the grounding data refutes that (Dmytro touches infra ~weekly; most free users less often; a map that is green every morning trains the user to stop looking in three weeks). The loop is **event-driven + weekly**:

1. **Apply-time review (the recurring hook, weekly):** agent proposes a change → plan diff renders on the canvas (create/update/delete/replace coloring, already built) → guardrails evaluate → human clicks Approve → apply runs locally → canvas animates to new state. This is the moment the product exists for; agents made infra changes MORE frequent and each change LESS legible.
2. **Monday sweep (the consultant ritual, weekly):** fleet grid of client accounts, red/yellow/green → click into the red one → ghosted unmanaged resources and drifted nodes surface → one click hands the finding to the agent → diagnosis + fix as an approvable plan → bill 20 minutes instead of 3 hours. Fleet view ships in Stage 3; Stage 2 validates the single-account version of this ritual first.
3. **Sunday review (the retention centerpiece, push-based):** a scheduled local job the agent runs — drift reconciliation, unused-resource report, upgrade proposals — delivered as a digest of approvable plans. Cheap to build, recurs regardless of change volume, delivers value even when the user initiates nothing. Promoted from a buried Studio one-liner to a headline feature — and given its own validation gate in Stage 3, because "centerpiece" is currently an assertion.

The notification/tray alert is the trigger surface; the canvas is the destination, not the habit.

### Feature set by pillar

**Canvas**
- Live React Flow map from terraform state/plan; file watcher + WebSocket live updates (exists)
- Plan-diff coloring, sensitive masking, module/VPC grouping (exists)
- Drift lens: ghosted unmanaged resources, per-node drifted attributes
- Fleet view: grid of AWS profiles/regions, red/yellow/green per account — zero shared state, purely local

**Agent**
- Constructor: drag from palette, draw connections, context-menu modify/remove → structured intent JSON → agent writes all HCL (exists; the agent IS the codegen — no template library to maintain)
- Investigate button: any node/badge spawns a scoped agent session pre-loaded with ARNs, recent logs, matching HCL; read-only tools only; returns diagnosis + fix as a plan
- Approval-gated mutation as the write path — **scoped honestly by tier:** in the OSS plugin it is approval-gated *by convention* (the skill instructs the agent to route every mutation through canvas approval, but the agent has a shell and nothing physically stops a `terraform apply` outside the canvas); in Studio it is approval-gated *by construction* (the credential broker withholds mutate-scope credentials until a human approves)
- Guardrails: declarative policy file checked into the repo (no public S3, no 0.0.0.0/0 on DBs, protected-env deny-lists) + a structural destroy/replace interlock with a distinct, scarier approval path (typed confirmation). **Advisory in the plugin; enforcing only in Studio behind the broker**
- Pluggable agent runtime: Claude Code/Agent SDK is the first backend, not the foundation; anything speaking MCP works

**Observe (deliberately shallow)**
- Read-only scan engine: ~20 resource types at launch (VPC/EC2/RDS/Lambda/ECS/S3/SQS/IAM/ALB/CloudFront/NAT/EIP...), covering ~90% of a seed-stage account; grown toward 60 over time. Not 60 at launch — that's scope vanity
- Three-way reconciliation: live account vs terraform state vs HCL → managed/unmanaged/drifted node styling
- Curated top-5 signals per resource type as node badges, **drawn from metrics that exist with zero setup** — LB 5xx and target errors, Lambda error/throttle rates, RDS CPU/storage/connections, SQS queue depth; CloudWatch alarms surface only where the account actually has them (the ICP mostly doesn't — same reason the incident copilot is out). On-demand log tail in a side panel; nothing stored long-term — the explicit line that keeps this from becoming Datadog
- Cost: account-level week-over-week deltas first (Cost Explorer lags 24–48h and per-node tag attribution is fiction for shared resources — per-node cost ships only after drift has earned trust)

**Day-2**
- Adopt-into-Terraform: agent writes import blocks + matching HCL for unmanaged resources, module by module, each import an approvable diff. Honest promise: **hours, human-reviewed** — not "20 minutes to fully managed" (terraform import on accreted accounts is where Terraformer and former2 died)
- Sunday review digest (above)
- Append-only local audit log of every agent action, STS call, and approval — exportable as the SOC 2 / client-report artifact. This is the most defensible dollar-denominated claim in the product and leads the paid pitch
- CI handoff (later stage): generated GitHub Actions that reproduce apply exactly, state in the user's S3/DynamoDB backend — desktop is the cockpit, not a single point of failure

---

## 3. What it is NOT

- **Not a PaaS / deploy engine.** No build→ECR→ECS pipeline, no preview environments, no health-gated rollouts, no Lambda/CloudFront deploy targets. Flightcontrol raised millions and took years on that alone. Coolify/Dokploy own the "flee AWS" crowd; we serve people staying on raw AWS with Terraform.
- **Not a monitoring platform.** Top-5 curated signals and on-demand log tails, full stop. Users with Datadog keep Datadog. No DuckDB-as-Datadog-lite ambitions.
- **Not a bidirectional visual IaC compiler.** No service-spec↔HCL re-anchoring — that's a research problem every visual codegen tool died on. Hand-edited HCL is simply the source of truth; "ejected" is the only mode.
- **Not an autonomous SRE.** No incident copilot in v1 (the ICP has approximately zero CloudWatch alarms configured), no auto-remediation ever. Agent proposes; a human with a mouse disposes.
- **Not an enterprise governance platform.** No RBAC, SSO, central control plane, or vendor-hosted anything in core. Enterprises wanting centralized credential governance are Pulumi Neo's fight.
- **Not multi-cloud at launch.** AWS only. Each additional cloud is a full read-path build.
- **Not a template marketplace.** "The agent is the codegen" makes paid templates worthless by our own thesis.
- **Not a daily-habit dashboard.** We do not claim it; we do not build for it; we do not measure DAU as success.

---

## 4. Architecture end-state

**Everything runs on the user's machine. Vendor-side infrastructure = a license/update server only. Zero credentials and zero infra data vendor-side; opt-in anonymous usage pings only. Delete the app and you keep a plain Terraform repo.**

**Data boundary (the honest version):** credentials never leave the machine — but agent sessions do send data to the model API (Anthropic, or whatever backend the user plugs in): resource metadata, HCL, log excerpts pulled into Investigate/Sunday-review context. Tags and env-var-shaped attributes can contain secrets. Therefore: (a) a **redaction/allowlist layer** sits between the scan graph and agent context — what resource attributes may enter a prompt is explicit and user-editable (Stage 2 deliverable); (b) a **no-LLM mode** — canvas, drift, fleet view with zero model calls — is a supported configuration, not a degraded afterthought, because for MSA purposes the model vendor is itself a third party; (c) the question "does your MSA tolerate redacted metadata to a model API, or do you need no-LLM mode?" is asked verbatim in the 20 consultant calls. This is the difference between a wedge claim that survives due diligence and one that dies in Maya's first client review.

**Kept from stackcanvas today (the core rendering/protocol layer):** React Flow canvas, terraform state/plan parser + diff highlighter, file watcher + WebSocket bus, structured-intent pipeline (`await_canvas_intent` MCP tool), sensitive masking, module/VPC grouping, plugin + skill teaching the agent loop.

**Added, in dependency order:**

1. **Source-graph abstraction:** the canvas renders a generic resource graph; tfstate is the *first provider*, not the foundation. Hedges Terraform BUSL/IBM risk and OpenTofu split (dual compatibility from day one); the live-scan provider plugs into the same interface. This refactor is an explicit Stage 2 deliverable, not background hand-waving.
2. **Scan engine (the real product):** local AWS SDK worker — Cloud Control ListResources plus hand-tuned describes for ~20 resource types, pagination, throttling backoff, relationship inference from SG rules, IAM attachments, ARN refs, tags; incremental refresh; persisted to local SQLite. Known tax: Cloud Control coverage gaps and rate limits are a permanent engineering cost — a stale map destroys the whole premise, so freshness is a first-class metric.
3. **Reconciliation layer:** joins scan graph with terraform state graph → managed/unmanaged/drifted model driving node styling. Matching live resources to TF addresses through modules/for_each/computed names is the hardest correctness problem in the product; v1 is state-anchored (start from what state claims, flag the rest as ghosts) rather than solving general matching.
4. **Agent runtime adapter:** embedded Claude Agent SDK sessions behind a versioned interface. Auth: **designed for BYO API key economics from day one; subscription auth treated as a bonus if ToS permits** (the load-bearing assumption per all three critiques). Read sessions get scoped read-only AWS tools + repo. The enforced write path — terraform plan → canvas render → guardrail check → human click → apply — exists only where the broker exists (Studio); in the plugin the same path holds by skill-enforced convention.
5. **Credential broker (a distinct, security-critical work item, built in two steps):** reads standard ~/.aws profiles/SSO. **Stage 2 ships a minimal read-only broker** — ambient profile, read-only session issuance for scan/Investigate, no audit log — because Investigate cannot exist without it. **Stage 3 upgrades it** to the full two-scope design: always-on read-only session plus a mutate session unlocked only for the duration of a human-approved apply, with every STS call and apply appended to the local audit log. Credentials never serialized into agent context.
6. **Policy engine:** declarative guardrail file in the repo, evaluated before the Approve button activates; destroy/replace detection triggers the typed-confirmation path. Advisory in the plugin, enforcing in Studio.
7. **Packaging:** MCP tool (npm) → **plugin update adds drift/investigate first** (validates the loop at zero desktop cost) → Tauri desktop shell (macOS first; small binary, Rust side runs the pollers; signing/notarization/auto-update budgeted as permanent tax) → Windows/Linux later.
8. **MCP as a versioned adapter, not architecture:** the intent loop already had to clamp to 45s to survive client timeouts, and a spec-breaking MCP revision landed on the calendar for 28.07.2026. CI against Claude Code latest; assume ~1 week/month of platform-churn breakage forever.

**Open-core split:** canvas + constructor + MCP + basic drift stay MIT (the star engine). Studio desktop — fleet view, scheduled scans/Sunday review, audit-log export, guardrails UI, signals — is the paid license with offline keys.

---

## 5. Staged roadmap

Estimates are pure-build solo-months; calendar time at KP's honest fractional capacity (~6–10 hrs/week alongside vizco et al.) is **2–3x — and every stage date below is computed at that multiplier**, not at the wishful ~1.3x an earlier draft used. Consequence, stated plainly: only Stages 1–2 fit inside the timing window (§7); the window claim therefore attaches to *occupying the slot*, not to revenue. Each stage has a falsifiable gate.

### Stage 0 — OSS MCP canvas (DONE, July 2026)
Parser, live canvas, constructor, intent loop, plan-diff, masking, grouping, plugin+skill, e2e verified, demo GIF. Pending: npm publish.

### Stage 1 — Ship distribution + instrumentation (now → mid-August 2026)
- **Goal:** occupy the empty registry slot while it's empty; start measuring instead of guessing.
- **Deliverables:** npm publish + Claude Code plugin registry placement; launch content riding the vibecoding-incident narrative (HN, r/devops, Terraform community) — **with every market stat (93%, 34%, 20%) verified against its primary source first; unverifiable numbers ship hedged or not at all** (a misquoted stat is a reputational tripwire in exactly the community being marketed to); verify + document Cursor and Windsurf setups (or explicitly drop the multi-client claim) and add them to the CI matrix; opt-in telemetry (installs, week-2 reopens, intents sent); GitHub Sponsors on; README email capture + pinned "would you pay" discussion.
- **Proves:** retention vs demo-ware — week-2 reopen rate and median intents/user are the two numbers that decide whether anything else gets built.
- **Effort:** ~2–4 weeks calendar; telemetry is ~3 days of build, the rest is launch ops.

### Stage 2 — Drift lens + Investigate, as a plugin update (Q4 2026 → Q2 2027)
- **Goal:** validate the paid thesis (drift + agent-hands) with zero desktop-app cost; validate consultant pricing with humans.
- **Deliverables:** source-graph provider-interface refactor (tfstate + live-scan as the first two providers; OpenTofu compatibility test in CI) — ~2–3 weeks of its own; scan engine for ~20 resource types; state-anchored reconciliation (ghost/drifted nodes); minimal read-only credential broker (ambient ~/.aws profile, read-only session issuance — the Investigate prerequisite); Investigate button (scoped read-only agent session → diagnosis + fix plan); redaction/allowlist layer for agent context (§4 data boundary); guardrail file + destroy/replace interlock (**advisory** at this stage — enforcement needs the Stage 3 broker); per-feature token-cost budget at API prices (feeds Decision 1 and the 2027-01-15 gate). Adopt-into-Terraform **moves to Stage 3** — the scope cut that keeps this stage inside the window. In parallel (calls, not build): **outbound to 20 fractional DevOps consultants** in Q4 2026 to test per-account pricing against the Hava anchor and the MSA/data-boundary question, before writing the scan engine's long tail.
- **Proves:** drift is the recurring hook — measured as **single-account drift-lens reopen: among telemetry-consenting users who run at least one scan, ≥25% re-open the drift lens in ≥3 distinct weeks within 8 weeks** (the Monday-sweep fleet ritual is a Stage 3 claim; this stage tests its single-account core). Payment intent — **≥10 of 20 outbound consultants verbally commit to a paid pilot at ≥$79/mo, of which ≥3 prepay or sign an LOI** — is the hard gate to Stage 3. Deposits, not sentiment. No desktop app before it.
- **Effort:** ~3–3.5 build-months; **6–10 months calendar at 2–3x** → ships ~Q2 2027.

### Stage 3 — Studio desktop + first revenue (Q3 2027 → H1 2028)
- **Goal:** convert the consultant segment; first $10k ARR. Revenue does not wait for the Tauri ship: pilot consultants from the Stage 2 outbound are invoiced manually on the plugin from mid-2027.
- **Deliverables:** Tauri shell (macOS first); credential broker upgrade (read/mutate split, apply-scoped mutate sessions, full audit log — completing the Stage 2 read-only broker); fleet view as profile grid (no sharing); scheduled scans + Sunday review digest; adopt-into-Terraform (agent-assisted import, human-reviewed, "hours, honestly"); audit-log export (the SOC 2 / client-report artifact leads the pitch); offline licensing; cost deltas at account level.
- **Proves:** 10 paying consultants (~$10k ARR) and OSS→paid funnel conversion; ten Mayas also put the product in front of ~40 CTOs. **Sunday review earns its "retention centerpiece" title or loses it: ≥50% of paying users open ≥2 of 4 weekly digests in month 2; if it flops, retention re-anchors on apply-time review + Monday sweep and the digest demotes to a settings option.**
- **Effort:** ~4–5 build-months; **8–15 months calendar at 2–3x.**

### Stage 4 — Deepen, only where pulled (2028+)
- **Goal:** expand from proven revenue, not from vision documents.
- **Candidate deliverables, strictly demand-gated:** per-node signals + log tail; per-node cost attribution; CI-handoff twin (GitHub Actions generator); Windows/Linux; brownfield wizard polish; Sam's team story (self-hosted sync — the one answer to "local-first inverts at 5 engineers"); resource types 20→60; **vendor security packet (own posture doc, pen test, SBOM) as the precondition to 2 enterprise design-partner conversations** — no packet, no enterprise line anywhere; incident triage (only if the ICP demonstrably has alarms by then).
- **Proves:** whether this is a $20–35k MRR business or a sustainable $10k side product — both are defined win states.

---

## 6. Business model

**Model: open-core with a paid local desktop tier — the monetization where the differentiator and the price tag are the same sentence.** The proven solo lane: TablePlus ($99–129 perpetual, bootstrapped 9 years), Tower (~100k paying devs, ~$70–140/yr), Screen Studio ($30k month one). The sobering counter-comp: Coolify, with best-in-class OSS traction (~55.7k stars), sits at ~$15k hosted MRR after 5 years — stars are not revenue; installs are the growth job.

**All prices below are hypotheses pending the Q4 2026 consultant outbound**, which tests the per-account number against Maya's $99/mo Hava anchor and her billable-hour arbitrage — "6 accounts beats any flat price" beats it for *us*; the calls establish whether it beats it for *her*.

| Tier | Price (hypothesis) | Tokens — who pays | Who |
|---|---|---|---|
| stackcanvas OSS | $0 forever | User's own agent (Claude subscription or BYO API key) | Dmytro — funnel, stars, word of mouth |
| Sponsors | $5/$25/$100 + $500–1k/mo corporate logos | — | Noise, $0.5–3k/mo; on from day 1; never in the P&L |
| Studio Consultant | **$25–40/account/mo, min 3 accounts, floor $79/mo** | BYO API key; every feature budgeted at API prices (Stage 2 deliverable) | **Maya/Marcus — pays FIRST.** Per-account tracks billable value; expensed per client |
| Studio Pro (individual) | $16/mo or $150–180/yr; $199 perpetual + $99/yr renewals for subscription-haters | BYO API key | Dmytro when his SOC 2 or bill-shock window opens |
| Team (Stage 4, only if pulled) | $30–40/seat/mo | BYO org API key | Sam — requires shared review, doesn't exist yet |
| Enterprise design partners | $15–25k/yr flat, cap 4 accounts while solo | Customer's own key / Bedrock | Regulated shops; sold on "AI infra agent your security team can approve"; **gated on the Stage 4 security packet, excluded from the base math** |

Tokens are never bundled into the license: Decision 1's risk ("$79 + $50–200/mo of tokens") is managed by budgeting every feature's token cost at API prices and disclosing it, not by absorbing it.

**Who pays first and why:** the fractional consultant — hard contractual constraint (no SaaS creds; model-API exposure handled via the redaction layer and no-LLM mode, §4) that disqualifies every funded competitor, existing spend on a worse tool (Hava, $99/mo, read-only), billable-hours arbitrage instead of fear-reduction, and least price sensitivity. Dmytro is distribution; the paid pitch to him leads with the audit-log/SOC 2 artifact, not convenience (convenience layers over prompts he already pays Anthropic for get $0–20, not $59).

**24-month math (consultant-denominated):** $20–35k MRR at a realistic $150–250/mo average consultant account (3–8 managed accounts) means **~100–200 paying consultants** — not "900–1,400 seats," which silently assumed mass conversion of a persona this document prices at $0. Assumed funnel, stated so it can be falsified: ~30–50k real installs → ~1,000 reachable consultants (community + outbound) → 10–20% paid conversion. Sanity check against our own comp: Coolify's 55.7k stars → ~$15k MRR after 5 years says the upper band is ambitious. Therefore **$10k ARR from ~10 consultants is the Stage 3 gate and the base-case win; $20–35k MRR is the upside case, not the plan.** First paid pilots are invoiced manually on the plugin from mid-2027 (see §8), ahead of the desktop ship. Enterprise deals are upside on top, contingent on the Stage 4 security packet.

---

## 7. Moat & timing

**Honest moat thesis: the tech is thin (React Flow + state parser + a blocking MCP tool ≈ one quarter for any funded team). What compounds:**

1. **Registry-default position** inside the agent loop — first-mover in a new plugin category compounds like Coolify's stars did; a me-too can't displace the default. This is why Stage 1 ships *this month*, ahead of any new feature.
2. **The intent-and-skill corpus** — every canvas gesture → intent JSON → correct HCL mapping across the AWS long tail. Collection mechanism, stated explicitly because local-first forbids harvesting it as telemetry exhaust: **community-PR'd skill and mapping files in the OSS repo** — contributors extend the gesture→HCL corpus the way oh-my-zsh accretes plugins. A fast-follower starts at zero on the corpus only if contributors actually materialize; this moat is earned, not automatic.
3. **Business-model conflict as a shield** — Pulumi, Spacelift, Brainboard, Firefly, HCP all monetize by holding state/creds/runs in their cloud; genuinely local-first cannibalizes their revenue, so they structurally won't follow (the same reason Coolify's incumbents never went self-hosted).
4. **The platform-independent assets** — scan engine, reconciliation model, credential broker, guardrails. These are deliberately where the engineering effort goes, because the MCP/agent layer is a swappable adapter that Anthropic can commoditize any release.

**Timing window: 2–4 quarters, closing mid-2027 — and the window claim attaches to the slot, not to revenue.** Three curves crossed in the last two quarters: agent-driven infra went mainstream (over 20% of infrastructure deployments on Pulumi's platform are LLM-driven, per Pulumi (their own blog claim, no third-party audit); 46% of teams in production or pilots with AI for infrastructure automation, per Firefly — vendor numbers, verified 2026-07-13 against primary sources), official plumbing landed (Terraform MCP server GA June 2026, 45+ AWS MCP servers), and the pain got quantified (the survey numbers above). HCP Infragraph (public preview May 2026) shows incumbents converging on live infra graphs; agent clients grow richer UI surfaces every release. Nobody owns the local human-agent visual supervision slot today. At honest 2–3x calendar math, only Stages 1–2 fit inside the window: **the play is to hold the slot by mid-2027 (registry default + drift lens live in the plugin) and monetize after it.** Revenue trailing the window is acceptable if the slot is held; failing to hold the slot trips the §8 gates. The scarce asset is the window, not the feature list.

---

## 8. Kill criteria & leading indicators

Written kill/commit gates — with this many parallel bets, the scarcest resource is the discipline to feed the project real hours or kill it cleanly instead of letting it zombie.

**Dated gates:**

| Date | Gate | Kill/pivot trigger |
|---|---|---|
| **2026-08-15** | npm published + plugin registry placement + telemetry live | Not shipped → the project is already the "last commit November 2026" obituary; publish or archive |
| **2026-10-15** (month 3 post-launch) | Week-2 reopen ≥15–20% **among telemetry-consenting installs, n≥100** (opt-in runs 5–20%, so the raw install count is not the denominator; if consenting n<100 the gate is undecidable — extend 6 weeks and add registry-update pings as a secondary denominator); median intents/user > 0; ≥5 unsolicited "can I pay / prod support?" inbound; ≥3 external PR authors | Reopen <5% = demo-ware — pivot to read-only review pane or kill. Median intents = 0 → constructor thesis falsified |
| **2027-01-15** | 20-consultant outbound complete: **≥10 of 20 verbally commit to a paid pilot at ≥$79/mo, of which ≥3 prepay or sign an LOI**; plus **written read on Anthropic ToS (subscription auth inside a third-party paid app) and per-feature token-cost estimates at API prices** for Sunday review and scheduled scans | <10 commitments or <3 deposits → do NOT build the desktop app; stay a thin OSS tool. ToS/economics unresolved → Stage 3 does not start; fall back to Decision 1 option (c) |
| **2027-07-01** (window close) | Stage 2 shipped (drift lens + Investigate live in the plugin) + ≥3 paid pilots invoiced manually on the plugin | Slot not held or zero paid pilots → fold to maintenance-mode OSS, defined as an acceptable end state, not a zombie |
| **2028-06-30** | ≥10 paying customers / ~$10k ARR on shipped Studio | Miss → maintenance-mode OSS, same defined end state |

**Continuous tripwires (act immediately, not at quarterly review):**
- Anthropic/Cursor changelog mentions a native visual/infra pane, or HashiCorp bundles a free local graph UI with the Terraform MCP server → reposition decision within 2 weeks (integration/acquisition posture is a defined win condition for a solo OSS project)
- Pulumi Neo announces a free tier or visual console → same
- **Breakage tax:** ≥2 releases forced purely by Claude Code/MCP changes in any 3-month window → quantified platform risk; revisit the adapter boundary
- **Founder hours:** <5 logged hrs/week for a month → the project is dead regardless of metrics; call it honestly (base-rate killer at ~60% likelihood per pre-mortem)
- **Trust incident:** any viral "agent destroyed prod" story (anyone's agent) → lead all marketing with the safety interlock + audit log within the same week

---

## 9. Open decisions for the founder

**1. Agent auth: design for BYO API key or bet on subscription passthrough?**
The load-bearing economic assumption of all three visions. If Anthropic restricts consumer-subscription auth inside a third-party paid app, "always-on agent" on metered tokens can cost the user more than the license, and "$79/mo Pro" quietly becomes "$79 + $50–200/mo of tokens."
*Options:* (a) subscription-auth-first, hope ToS holds; (b) API-key-first economics, subscription as bonus; (c) no embedded runtime — Studio only steers the user's existing Claude Code session.
*Recommendation:* **(b), with (c) as the fallback architecture** — budget every feature's token cost at API prices (now a Stage 2 deliverable), keep the runtime pluggable, and get a written read on the ToS question before any Tauri work starts. **This precondition is now encoded in the 2027-01-15 gate, not left as prose.**

**2. GTM: pure OSS inbound, or add the consultant outbound motion?**
The wedge (Dmytro, GitHub trending) and the payer (Maya, r/devops and consultant Slacks) are different people, and the funnel between them is asserted, not designed. Outbound is a second GTM motion on a founder already running ~ten bets.
*Options:* (a) OSS-only, wait for consultants to self-discover; (b) timebox 20 consultant conversations in Q4 2026 before building Stage 3.
*Recommendation:* **(b)** — it's ~20 calls, it tests per-account pricing at $25–40/account/mo against the Hava anchor, it asks the MSA/data-boundary question (§4) verbatim, and it's the cheapest possible insurance against building a desktop app for a segment that won't convert.

**3. Terraform-first or source-graph abstraction now?**
BUSL + HashiCorp-under-IBM (Infragraph converging on our slot) makes the substrate owner both dependency and likeliest fast-follower; meanwhile agents increasingly act on cloud APIs directly.
*Options:* (a) tfstate-native, abstract later; (b) generic resource-graph interface now, tfstate + live-scan as the first two providers, OpenTofu dual-compat from day one.
*Recommendation:* **(b)** — the scan engine needs the abstraction anyway in Stage 2 (where it is now an explicit deliverable with its own weeks), and it converts the biggest platform risk into an on-ramp for the zero-Terraform user (canvas works on a raw account).

**4. Brand: one name or OSS/paid split?**
*Options:* (a) "stackcanvas" everywhere, "Studio" as the paid tier name; (b) separate product brand for the desktop app (Stackpilot / Mission Control).
*Recommendation:* **(a)** — the OSS repo is the only distribution asset that exists; every rename resets registry ranking, tutorial mindshare, and star equity, which the moat thesis says are the actual moat.
---

## Founder decisions (2026-07-12, KP)

1. **Agent auth/economics:** deferred — focus is pure OSS for now; monetization decisions (API-key vs subscription, Studio pricing) revisit at the 2026-10-15 gate with real retention data. The 2027-01-15 consultant-outbound gate is suspended accordingly.
2. **GTM:** OSS-inbound only. No consultant outbound motion for now; paid-tier validation waits until OSS traction data exists.
3. **Substrate:** source-graph abstraction in Stage 2 confirmed — tfstate + live-scan as first two providers, OpenTofu in CI.
4. **Brand:** stackcanvas everywhere; "Studio" as the paid tier name if/when it comes.

Practical consequence: Stage 1 (npm publish, plugin registry, launch content, opt-in telemetry) is the only priority; Stage 2 planning starts after the 2026-10-15 retention gate reads.
