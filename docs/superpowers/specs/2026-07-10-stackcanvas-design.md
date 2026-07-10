# stackcanvas — Design

**Date:** 2026-07-10
**Status:** Approved (brainstorm with KP)

## What it is

An open-source MCP tool for Claude Code: a live, interactive canvas of your
infrastructure. Claude Code is the engine that writes and applies Terraform;
stackcanvas is the steering wheel and the window. The user watches the
infrastructure graph update live as the agent works, and can drag new
resources onto the canvas — the agent turns them into idiomatic HCL.

**Role:** standalone OSS wedge. Useful by itself, earns GitHub stars, and
becomes the visual core of a future desktop product (give it your AWS creds,
manage/monitor/build infra in one UI). The name is deliberately not tied to
Terraform: v1 reads Terraform state/plan, but the canvas is for cloud
architecture in general.

## v1 scope

- **Data source:** local Terraform state + plan (`terraform show -json`),
  in the repo where Claude Code runs. No cloud credentials needed.
- **Consumption:** local web UI (localhost) with live updates. No static
  export in v1.
- **Interactivity:** full constructor — read the graph, inspect nodes,
  AND drag new resources / draw connections / mark removals.
- **Codegen:** the agent writes all HCL. The canvas produces a structured
  *intent*, never Terraform code. No template generator of our own.

### Explicitly NOT in v1

- Live AWS account scanning, drift detection
- Multiple Terraform roots at once
- Apply button in the UI (only the agent executes — this is a principle)
- Cost estimation
- Remote access / auth (localhost only)
- Static SVG/PNG export

## Architecture

One TypeScript monorepo (pnpm workspace), published as a single npm package
with the UI build embedded. Four modules with hard boundaries:

### 1. `packages/core` — graph engine (no UI, no IO)

- **Input:** JSON from `terraform show -json` (state) and
  `terraform show -json <planfile>` (plan).
- **Output:** normalized `GraphModel`:
  - `nodes`: resources with type, provider, name, address, attributes
  - `edges`: dependencies (`depends_on` + expression references)
  - `groups`: module nesting and VPC/subnet containment
- **Diff engine:** `resource_changes` from plan → per-node status:
  `create | update | delete | replace | noop`, plus attribute-level diff.
- Pure functions; unit-testable on fixtures.

### 2. `packages/server` — local server (Hono)

- Serves the static UI build, a WebSocket channel, and REST for graph JSON.
- **Watcher (chokidar):** watches `*.tfstate` and the registered plan file;
  on change → re-parse via core → push updated graph over WS.
- **Intent queue:** UI "Apply" POSTs an intent JSON; queued until the agent
  collects it.
- Tracks agent status (intent collected / plan refreshed) and pushes it to
  the UI as a status badge.

### 3. `packages/mcp` — MCP layer (stdio)

Four tools:

| Tool | Behavior |
|------|----------|
| `open_canvas(dir)` | Start/reuse the server for a Terraform root, return URL, open browser |
| `load_plan(path)` | Register a plan file for diff highlighting |
| `get_graph_summary()` | Text summary of the graph for agent context |
| `await_canvas_intent(timeout)` | **Blocking** long-poll; returns intent JSON when the user hits Apply, `{intent: null}` on timeout |

### 4. `packages/ui` — canvas (React + React Flow)

- ELK auto-layout (left-to-right), provider icons, group containers
  (module → VPC → subnet).
- Click a node → inspector panel: state attributes, plan attribute diff.
- Plan status overlays: green outline (create), yellow (update),
  red (delete), purple (replace). "Show plan" toggle.
- **Palette:** top ~25 AWS resource types (VPC, subnet, EC2, RDS, S3, ALB,
  ECS/Fargate, Lambda, SQS, SNS, CloudFront, Route53, IAM role, security
  group, …) + a generic "any terraform type" node with a free-text type
  field.
- **Draft layer:** dragged resources render dashed on top of the real
  graph; edges can be drawn to existing nodes; inspector has a free-text
  "wishes" field per draft node (e.g. "db.t4g.micro, no multi-AZ").
  No attribute validation — that's the agent's job.
- **Modify/remove on existing nodes:** context menu → "request change"
  (opens the wishes field, node gets a pencil badge) or "mark for removal"
  (node rendered struck-through). Both are drafts until Apply.
- **Apply** collects all drafts/edits into one intent.

## Data flow

**Read loop (live map):**
agent edits infra → state/plan changes on disk → watcher → core parser →
WS push → canvas re-renders with diff badges. The agent doesn't need to
call anything for the map to stay alive.

**Write loop (constructor):**
user drags resources → Apply → intent JSON →
`await_canvas_intent` returns it to the agent → agent writes idiomatic HCL
in the repo's style → runs `terraform plan` → watcher picks it up →
dashed drafts are reconciled into real nodes with plan status.

**Intent format:**

```json
{
  "add":    [{ "type": "aws_db_instance", "name?": "...", "wishes?": "...",
               "connect_to": ["aws_vpc.main"] }],
  "modify": [{ "address": "aws_instance.web", "wishes": "..." }],
  "remove": [{ "address": "aws_s3_bucket.legacy" }]
}
```

**Fallback** when no agent is waiting: "Copy as prompt" button — the intent
rendered as a ready-to-paste text prompt.

## Agent workflow (bundled skill)

Ships with a Claude Code skill (`stackcanvas`) that teaches the loop:

1. `open_canvas` → 2. `terraform plan` + `load_plan` →
3. loop: `await_canvas_intent` → write HCL → `terraform plan` → repeat.

The user runs one command and then lives in the browser; the agent idles in
the await-loop. Agent status (writing code / planning / idle) is visible on
the canvas.

## Error handling

- No `terraform` binary or not a Terraform root → clear MCP tool error;
  UI shows an empty state with a hint.
- Corrupt/partially-written state during rewrite → keep last valid graph,
  show a "stale" banner; never crash the canvas.
- Sensitive attributes (per Terraform's `sensitive` flags) are masked
  before being sent to the UI.
- Server binds 127.0.0.1 only; port auto-selected on conflict.
- `await_canvas_intent` timeout → `{intent: null}`; the agent decides
  whether to keep looping.
- Large graphs (500+ nodes) → groups collapsed by default, expand on click.

## Testing

- **core:** unit tests on `terraform show -json` fixtures (VPC+EC2+RDS,
  nested modules, plan with create/update/delete/replace). Parser and diff
  are pure functions.
- **server:** integration — swap a state file in a temp dir → assert WS push.
- **mcp:** blocking `await_canvas_intent` test (intent enqueued → tool
  releases with the payload).
- **ui:** Playwright smoke — fixture graph renders; palette drag creates a
  draft; Apply emits correct intent JSON.
- **demo repo:** real Terraform config (plan only, no apply) — doubles as
  the README GIF material.

## Distribution

- npm package `stackcanvas` (`npx stackcanvas` = MCP stdio server).
  Name verified free on npm; zero GitHub collisions (checked 2026-07-10).
- Claude Code plugin (`plugin/`): MCP config + the skill, for the plugin
  marketplace.
- README with an animated GIF of the loop (agent builds → map grows →
  user drags → agent codes it) as the primary marketing asset.

## Competitive positioning (context)

- Brainboard: closed SaaS constructor, own template codegen, no MCP/CLI.
- Rover/Inframap/Pluralith: read-only visualizers, no live loop, no agent.
- Pulumi Neo / Spacelift: agentic IaC platforms, top-down enterprise.
- **stackcanvas:** local-first, agent-native (the agent is the codegen),
  and the only one built as a Claude Code tool. The visual layer nobody
  ships as a reusable component.
