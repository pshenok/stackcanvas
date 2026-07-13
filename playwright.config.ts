import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from '@playwright/test'

// Hermetic consent config: the e2e server (packages/mcp/src/cli.ts serve)
// constructs a default TelemetryClient that reads/writes
// ~/.stackcanvas/config.json unless STACKCANVAS_CONFIG_DIR is set. Point it
// at a fresh temp dir per test run so e2e never touches (or is polluted by)
// a real machine's telemetry consent state.
const telemetryConfigDir = mkdtempSync(join(tmpdir(), 'sc-e2e-config-'))

export default defineConfig({
  testDir: 'e2e',
  use: { baseURL: 'http://127.0.0.1:4681' },
  webServer: {
    command:
      'pnpm exec tsx packages/mcp/src/cli.ts serve --dir e2e/fixtures/tfroot '
      + '--fixture packages/core/test/fixtures/state.json --port 4681',
    url: 'http://127.0.0.1:4681/api/graph',
    reuseExistingServer: false,
    env: { STACKCANVAS_CONFIG_DIR: telemetryConfigDir },
  },
})
