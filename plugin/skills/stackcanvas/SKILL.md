---
name: stackcanvas
description: Open a live visual canvas of the Terraform infrastructure in this repo and enter the collaborative loop where the user draws changes and you write the HCL. Use when the user asks to visualize infrastructure, open the canvas, or build infra visually.
---

# stackcanvas loop

1. Call `open_canvas` with the absolute path to the Terraform root of this repo
   (the directory containing the `.tf` files).
2. If state exists, run `mkdir -p .stackcanvas && terraform plan -out=tfplan && terraform show -json tfplan > .stackcanvas/plan.json`
   so the canvas highlights pending changes. Add `.stackcanvas/` to .gitignore if missing.
3. Enter the loop:
   a. Call `await_canvas_intent` (default timeout 45s — kept under typical MCP client
      request timeouts; do not pass larger values, loop instead).
   b. If the result is `{"intent": null}`, call it again — unless the user has asked
      you to stop or the conversation has moved on.
   c. When an intent arrives: write idiomatic HCL for every `add`/`modify`/`remove`
      entry, matching the existing repo style and module layout. `wishes` fields are
      the user's free-text requirements — honor them. `connect_to` lists existing
      resource addresses the new resource must reference.
   d. Run `mkdir -p .stackcanvas && terraform plan -out=tfplan && terraform show -json tfplan > .stackcanvas/plan.json`.
      The canvas updates automatically. NEVER run `terraform apply` unless the user
      explicitly asks.
   e. Briefly tell the user what you changed, then go back to (a).
4. `get_graph_summary` is available whenever you need the current graph in text form.
