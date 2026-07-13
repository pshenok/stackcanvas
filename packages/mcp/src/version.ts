// Single source of truth for the published `stackcanvas` package version at
// runtime. Used as:
//   - the MCP server's protocol `version` (packages/mcp/src/server.ts)
//   - TelemetryEnvelope.app_version (packages/server/src/telemetry.ts), via
//     the TelemetryClient constructed in packages/mcp/src/cli.ts
//
// Bump this alongside packages/mcp/package.json's "version" field.
// scripts/check-plugin.mjs already enforces plugin.json/package.json version
// parity; wiring this file into that check (and into a bump-version.mjs
// script) is release-engineering scope (docs/SPEC.md Telemetry chapter, §5 /
// increment 8), not part of the emitter wiring here — keep the two in sync
// by hand until that lands.
export const VERSION = '0.2.2'
