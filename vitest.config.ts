import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

// Hermetic telemetry config for every test in this run, mirroring
// playwright.config.ts's e2e setup: any CanvasServer/TelemetryClient built
// with no explicit configPath falls back to STACKCANVAS_CONFIG_DIR before
// ~/.stackcanvas. Without this, tests that don't inject a telemetry client
// read the *real* machine-local config file — which, now that
// TelemetryClient's default transport is real `fetch` (M1-6 / #10), could
// fire genuine network requests during `pnpm test` on a dev machine that has
// ever granted consent locally. Tests that care about consent state still
// pass their own configPath/env and are unaffected by this default.
const telemetryConfigDir = mkdtempSync(join(tmpdir(), 'sc-unit-config-'))

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts'],
    environment: 'node',
    env: { STACKCANVAS_CONFIG_DIR: telemetryConfigDir },
  },
})
