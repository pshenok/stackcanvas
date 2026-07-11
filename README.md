# stackcanvas

Live infrastructure canvas for [Claude Code](https://claude.com/claude-code).
The agent writes and plans your Terraform — stackcanvas shows it as a living
diagram. Drag new resources onto the canvas; the agent turns them into
idiomatic HCL. No SaaS, no credentials leave your machine: everything runs on
localhost, reading your local state and plan.

## How it works

1. `open_canvas` starts a local web UI for your Terraform root.
2. The graph re-renders live whenever `*.tfstate` or `.stackcanvas/plan.json`
   change — you watch the agent work.
3. You drag resources from the palette (or right-click existing ones to
   request changes / removal) and hit **Apply**.
4. The agent receives your edits as a structured intent via
   `await_canvas_intent`, writes the HCL, runs `terraform plan`, and the
   canvas highlights what will change. Only the agent executes Terraform —
   the canvas has no apply button by design.

## Install (Claude Code)

    claude mcp add stackcanvas -- npx -y stackcanvas

Then, inside a repo with Terraform:

    /stackcanvas

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
