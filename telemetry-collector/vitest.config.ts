import { defineConfig } from 'vitest/config'

// Plain vitest, no AWS SAM/Lambda-local runtime. src/validate.ts is pure
// TS/JS with zero AWS imports; src/handler.ts takes its Firehose client as
// an injected `FirehoseLike` (see createHandler()), so tests fake it with a
// plain vi.fn() spy instead of the real @aws-sdk/client-firehose — no
// credentials, no network, no `sam local invoke`. See src/handler.test.ts.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
