# Contributing to stackcanvas

## Dev setup

```
git clone https://github.com/pshenok/stackcanvas.git
cd stackcanvas
npx pnpm@9 install
npx pnpm@9 test          # unit + integration
npx pnpm@9 e2e            # playwright smoke (builds the UI first)
```

Node >=20. This is a pnpm workspace (`packages/core`, `packages/server`,
`packages/ui`, `packages/mcp`); `telemetry-collector/` is a standalone
Lambda deliberately outside the workspace — see its own README for `npm`
setup.

## Best first PR: a provider pack

Adding a cloud provider is pure data, no core changes required. See the
"Multi-cloud" section of the [README](README.md#multi-cloud) for the three
files a pack touches:

- `packages/ui/src/resource-palette.ts` — curated drag-and-drop types
- `DEFAULT_CONTAINMENT_RULES` in `@stackcanvas/core` — which resources
  render as visual containers
- `packages/ui/src/icons.tsx` — icon patterns

AWS is the only pack that exists today; GCP or Azure are good starting
points.

## PR conventions

- Commit messages and PR titles follow [Conventional
  Commits](https://www.conventionalcommits.org/) (`fix:`, `feat:`,
  `chore:`, etc.).
- New behavior needs a test — unit/integration under the relevant
  `packages/*`, or a Playwright case under `e2e/` for UI flows.
- CI must be green (`unit`, `it-tf`, `check-plugin`, and the other jobs in
  `.github/workflows/ci.yml`) before merge.
- Keep PRs scoped to one change; large refactors are easier to review split
  up.

Design context for anything non-obvious lives in [`docs/SPEC.md`](docs/SPEC.md),
[`docs/PROBLEM.md`](docs/PROBLEM.md), and [`docs/VISION.md`](docs/VISION.md).
