import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  use: { baseURL: 'http://127.0.0.1:4681' },
  webServer: {
    command:
      'pnpm exec tsx packages/mcp/src/cli.ts serve --dir e2e/fixtures/tfroot '
      + '--fixture packages/core/test/fixtures/state.json --port 4681',
    url: 'http://127.0.0.1:4681/api/graph',
    reuseExistingServer: false,
  },
})
