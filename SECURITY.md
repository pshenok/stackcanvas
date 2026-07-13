# Security Policy

## Reporting a vulnerability

Please report security issues privately via [GitHub Security
Advisories](https://github.com/pshenok/stackcanvas/security/advisories/new)
for this repo — not a public issue or PR. We aim to respond within **72
hours**.

## Scope

- The local canvas server (`packages/server`) and its `/api/*` routes,
  including the Host/Origin allowlist
- Terraform/OpenTofu state and plan parsing (`packages/core`)
- The telemetry pipeline: client (`packages/server/src/telemetry.ts`) and
  collector (`telemetry-collector/`)

Out of scope: vulnerabilities in Terraform/OpenTofu themselves, or in cloud
provider APIs stackcanvas reads from.
