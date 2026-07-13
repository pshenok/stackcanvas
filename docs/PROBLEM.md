# The Problem — and How stackcanvas Solves It

## The problem we solve

**In one sentence: AI agents now change infrastructure faster than a human can read the diffs — while the only surface of control is still a wall of text in a terminal.**

The problem has four layers, and together they form a single hole in the market.

### 1. The supervision problem: the agent acts, the human can't see (the core)

Claude Code, Cursor, and their peers can already operate infrastructure end to end: they write Terraform, run plans and applies, fix configs. This moved two dials at once — both in the wrong direction:

- **Change frequency went up.** What used to be "once a sprint, by a senior engineer's hands" became "five times a day, from a prompt."
- **Legibility of each change went down.** The agent emits a 200–400-line `terraform plan`, and the human "reviews" it by scrolling. Nobody honestly reads diffs of that size at that frequency.

Meanwhile, infrastructure is **a graph by nature** — resources and the edges between them. Yet all of today's control is linear text. A text diff hides the thing that matters most: *what this change will touch around itself.* A red `-aws_db_instance.prod` line buried in a wall of text and a red node with five edges on a map are two different speeds of comprehension — and two different costs of error.

The result is a fork everyone who gave an agent infrastructure access is stuck in: either you **slow the agent down** with manual line-by-line review (losing the speed you hired it for), or you **rubber-stamp approvals** (and eventually collect your own "the agent destroyed prod" incident — [93% of organizations report at least one AI-caused infrastructure incident](https://spacelift.io/infrastructure-automation-survey-2026), per Spacelift's 2026 survey, and [only 34% of practitioners would trust AI agents to make autonomous production changes, even with guardrails](https://www.firefly.ai/state-of-iac-2026), per Firefly's State of IaC 2026). Text is a bad steering wheel and a worse rear-view mirror.

### 2. The input problem: telling the agent what to do in words is also broken

The flip side of the same coin. "Add an RDS in the main VPC, connect it to the web service, small instance, no multi-AZ" is ambiguous in text (which VPC? which of the three `web`s?), and resource addresses have to be remembered and typed without typos. **Drawing it** — dragging a block, pulling an edge to a specific node — is faster and more precise: the intent reaches the agent with exact resource addresses and zero ambiguity. The human draws *what*; the agent writes *how*.

### 3. The invisibility problem: "what is actually running in my cloud?"

An old pain that agents made worse: state ≠ console ≠ HCL. Forgotten resources burn money, drift accumulates, and "who created this security group" is archaeology. Existing answers are either dead or static (Rover, Inframap, Pluralith — a picture on demand, no life in it) or the AWS console — fifty tabs and no whole picture. A live map of *your estate* that redraws itself when the state changes did not exist.

### 4. The trust problem: everything that exists demands your keys

Everything that can "show and steer" is SaaS: Brainboard, Spacelift, Pulumi Cloud, env0, Flightcontrol. To be fair, two offer self-hosted execution tiers — [Spacelift Self-Hosted](https://docs.spacelift.io/self-hosted) and [env0 self-hosted agents](https://docs.env0.com/docs/self-hosted-kubernetes-agent) — but the visual/agentic control layer you actually steer from is still their SaaS, typically behind enterprise pricing. The default path for all five remains: **upload your prod credentials/state to our cloud.** For a solo founder that's uncomfortable; for a DevOps consultant under client MSAs it's literally contractually forbidden; for a post-SOC2 team it's blocked by policy. And this is not a bug in the competitors — it's their business model: they monetize holding your state and runs in their cloud, so they structurally cannot go local-first.

### Why now

Three curves crossed in the last two quarters: agent-driven infra changes went mainstream ([Pulumi says LLMs now handle over 20% of infrastructure deployments on its platform, up from "virtually zero a year ago"](https://www.pulumi.com/blog/the-agentic-infrastructure-era/)), the official plumbing landed ([Terraform MCP server reached GA on June 11, 2026](https://www.hashicorp.com/en/blog/terraform-mcp-server-is-now-generally-available), and [AWS's official MCP collection has grown past 60 servers](https://awslabs.github.io/mcp/) — all of them building the agent's *hands*), and the pain got quantified by the surveys above. **Everyone is building hands for the agent. Nobody is building eyes and a steering wheel for the human who answers for it.** That slot — local, visual, human↔agent supervision — is empty. We're taking it.

> **The launch formula:** Your AI agent can change your infrastructure faster than you can read its diffs. stackcanvas is the missing supervision surface: a live local map of your infra where you see what the agent is about to do — and approve it — before it happens. Your credentials never leave your machine.

---

## How we solve it

The solution rests on one principled division of labor: **the human sees and decides — the agent executes — the tool is the surface between them.** We are not building yet another agent, and we are not building yet another Terraform generator. We are building the missing layer between the agent you already have and the human who is responsible for it. Here is the mechanics, layer by layer.

### Layer 1. Supervision: a live map instead of a wall of text

**The read loop (working today):**

1. The source of truth is local Terraform state and plan. The tool runs `terraform show -json` and parses the output into a normalized graph model: nodes (resources with type, provider, attributes), edges (from `depends_on` plus a heuristic: a node attribute equal to another node's physical `id` is a dependency), and groups (modules, plus containment rules — resources with a `vpc_id` render *inside* their VPC, those with a `subnet_id` inside their subnet).
2. A file watcher (chokidar) tracks `*.tfstate` and `.stackcanvas/plan.json`. Any change → 300ms debounce → re-parse → WebSocket push → the canvas redraws. **The agent doesn't have to call anything for the map to stay alive** — it just works, and the map reflects it. This is critical: supervision that requires the supervised party's cooperation is not supervision.
3. **The plan diff is the centerpiece screen.** When the agent runs `terraform plan`, the canvas overlays statuses: green outline = create, yellow = update, red = delete, purple = replace. Click a node — the inspector shows the exact attribute diff (before → after, red/green). A five-hundred-line text plan collapses into a picture readable in seconds: *what* changes, *where* it sits in the topology, *what* hangs on its edges.

Why this resolves the "slow down or rubber-stamp" fork: the cost of a meaningful review drops by an order of magnitude. A red node with five edges in the middle of the graph screams in a way that a `-aws_db_instance.prod` line in a terminal never will. The human gets comprehension back without taking away the agent's speed.

Supervision fail-safety: if the state is corrupt or terraform fails, the canvas keeps the last valid graph and shows a "stale" banner instead of crashing. A dead canvas at the moment of a dangerous change is the worst possible failure, so this path has its own tests.

### Layer 2. Input: drawing as a strict intent protocol

**The write loop:**

1. The palette (provider packs — AWS first, plus an "any terraform type" field for everything else) → drag → a **dashed draft node** appears on the canvas. A draft is not reality — the visual grammar is strict: what exists is solid, what's intended is dashed.
2. You pull edges from the draft to existing nodes ("connect it to *this* VPC" — as a gesture, not an address from memory). The inspector has a free-text "wishes" field ("db.t4g.micro, no multi-AZ"). Right-click on an existing node — "request change" or "mark for removal" (rendered struck-through, dashed). An edge drawn between two existing nodes = a "connect them" request.
3. The **Send to agent** button collects everything into a single intent JSON with strict resource addresses: `{add: [{type, wishes, connect_to: ["aws_vpc.main"]}], modify: [{address, wishes}], remove: [{address}]}`. No "which of the three webs" ambiguity — addresses come from the graph, not from the human's memory.
4. The agent receives the intent through a blocking MCP tool, `await_canvas_intent`: it waits in a loop (45-second iterations — tuned to MCP client request timeouts, a number discovered by live testing), and the moment you hit Send to agent, the intent arrives as the tool's return value. A bundled skill teaches the agent the whole cycle (shipped for Claude Code; the tool descriptions alone carry the loop for other MCP clients): open the canvas → run a plan → await intents → write HCL → plan again → await again. The user runs one command and then lives in the browser with a mouse.
5. **Only the agent writes HCL.** The tool contains zero code-generation templates — a deliberate architectural bet. Template codegen (the Brainboard path) is an eternal race to cover thousands of resource types, producing code that's foreign to your repo. The agent writes in *your repository's* style, knows its modules and conventions, and covers all of Terraform at once. Our "codegen" gets cheaper and smarter with every model release — for free.
6. The loop closes by itself: the agent writes code → runs a plan → the watcher notices → drafts dissolve into real nodes with plan statuses → the human reviews the diff → tells the agent to apply. If no agent is waiting (or you use a different client), a "Copy as prompt" button turns the intent into a ready-to-paste text prompt.

### Layer 3. Invisibility: from a map of state to a map of reality

The first floor is solved today: a live map of what you *manage* (state) — already far more than what existed (Rover/Inframap give a dead picture on demand; ours is alive). The second floor is architecturally staged for Stage 2: the core is being decoupled from Terraform via a **source-graph abstraction** — tfstate is merely the first graph provider; the second will be a **read-only live account scan** (~20 resource types cover ~90% of a seed-stage account). That enables three-way reconciliation: live account vs state vs HCL → the map reveals **ghost nodes** (exists but unmanaged — forgotten resources, manual edits) and **drifted nodes** (managed but diverged). Plus an Investigate button: clicking a problem node spawns a scoped read-only agent session pre-loaded with ARNs, recent logs, and the matching HCL — "figure it out and propose a fix as a plan."

### Layer 4. Trust: local-first as a construction, not a slogan

The concrete mechanisms that make trusting us unnecessary:

- **The server binds to `127.0.0.1` only.** Not "behind a login" — physically unreachable from outside. There is no cloud of ours to run your infrastructure through — state, HCL, and credentials have nowhere to go. (One honest exception: an **opt-in** anonymous telemetry counter — install/reopen/intent counts only, never resource data — declinable at first run, documented in [TELEMETRY.md](../TELEMETRY.md).)
- **The tool holds no credentials at all** (v1): it reads local state/plan files. Even the future account scan uses your local `~/.aws` profile with read-only sessions.
- **Secrets are masked before they reach the UI:** everything the state marks `sensitive` (passwords, keys) becomes `•••` inside the parser — verified by live testing against `random_password`.
- **The agent is your own.** We don't proxy tokens and don't embed our own LLM: it's whatever MCP-capable coding agent you already pay for — Claude Code, Cursor, Windsurf — with your key.
- **The UI has no `terraform apply` control — by design.** The primary button is "Send to agent": it hands your intent over, nothing more. The canvas proposes; only the agent executes, and the skill explicitly forbids `terraform apply` without an explicit human request. Today this is supervision *by convention*; in the Studio stage it becomes supervision *by construction* — a credential broker will physically withhold mutate-scope credentials until a human approves.

### Packaging: why it spreads on its own

Everything ships as one npm package (`npx stackcanvas` = a standard MCP stdio server with the UI embedded) plus a Claude Code plugin (config + skill) for one-command setup there. Installation is one command; Cursor and Windsurf are reported to work as standard MCP clients; Claude Code is the CI-verified path. Extension is data, not code: a new cloud = a PR with a provider pack (palette + containment rules + icons) — a deliberate moat mechanic: the gesture→HCL corpus and provider packs accrete in the OSS repo the way oh-my-zsh accretes plugins.

**The anti-scope is part of the solution:** not a PaaS (we don't hide Terraform), not monitoring (we won't rebuild Datadog — only signals available with zero setup), never SaaS, no codegen of our own. Every "not" keeps the product in the one empty niche: **eyes and a steering wheel for the human whose agent already has hands.**
