# stackcanvas

Live infrastructure canvas for [Claude Code](https://claude.com/claude-code).
The agent writes and plans your Terraform — stackcanvas shows it as a living
diagram. Drag new resources onto the canvas; the agent turns them into
idiomatic HCL. No SaaS, no credentials leave your machine: everything runs on
localhost, reading your local state and plan.

![stackcanvas demo](docs/demo.gif)

## How it works

1. `open_canvas` starts a local web UI for your Terraform root.
2. The graph re-renders live whenever `*.tfstate` or `.stackcanvas/plan.json`
   change — you watch the agent work.
3. You drag resources from the palette (or right-click existing ones to
   request changes / removal) and hit **Apply**. Connections between two
   not-yet-created (draft) resources aren't included in the intent yet —
   connect drafts to existing resources, or describe the relation in the
   draft's wishes field.
4. The agent receives your edits as a structured intent via
   `await_canvas_intent`, writes the HCL, runs `terraform plan`, and the
   canvas highlights what will change. Only the agent executes Terraform —
   the canvas has no apply button by design.

## Install (Claude Code)

    claude mcp add stackcanvas -- npx -y stackcanvas

Then, inside a repo with Terraform:

    /stackcanvas

## Multi-cloud

The canvas is provider-agnostic: **any Terraform provider in your state renders** —
AWS, GCP, Azure, Cloudflare, Datadog, `random`, all of them, in one graph
(a single Terraform root often mixes providers, so there is no "cloud switcher").
What's provider-specific is only the curation layer, shipped as **provider packs**:

- a palette pack (`packages/ui/src/resource-palette.ts`) — curated drag-and-drop types
- containment rules (`DEFAULT_CONTAINMENT_RULES` in `@stackcanvas/core`) — which
  resources render as visual containers (AWS VPC/subnet today)
- icon patterns (`packages/ui/src/icons.tsx`)

AWS ships first. Adding a GCP/Azure/other pack is pure data and makes a great
first PR.

## Tools

| Tool | Purpose |
|------|---------|
| `open_canvas` | Start the canvas for a Terraform root, open the browser |
| `load_plan` | Register a plan (JSON or binary) for diff highlighting |
| `get_graph_summary` | Text summary of the graph for the agent |
| `await_canvas_intent` | Block until the user clicks Apply; returns their edits |

## Demo

`examples/demo` contains a small AWS config. Run `terraform init && terraform plan -out=tfplan && terraform show -json tfplan > .stackcanvas/plan.json` there and open the canvas to see create-highlighting. `plan` does not create or modify any resources — nothing is provisioned until `terraform apply` (note: the AWS provider still needs credentials and makes read-only API calls during plan).

## Development

    pnpm install
    pnpm test          # unit + integration
    pnpm e2e           # playwright smoke
    pnpm build:pkg     # build the publishable package

## License

MIT
