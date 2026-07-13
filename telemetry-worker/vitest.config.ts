import { defineConfig } from 'vitest/config'

// Plain vitest, no Cloudflare test runtime (miniflare / @cloudflare/vitest-pool-workers).
// The worker's fetch handler is a pure function of (Request, Env, ExecutionContext) with
// no Workers-only globals beyond `fetch`/`Request`/`Response`/`URL`/`crypto.randomUUID`,
// all of which Node 20+ already provides — so Env (Analytics Engine dataset + R2 bucket)
// is trivially faked with plain objects in tests. This keeps the suite offline-safe (no
// workerd binary download, no `wrangler dev` needed) and fast in CI. See src/index.test.ts.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
