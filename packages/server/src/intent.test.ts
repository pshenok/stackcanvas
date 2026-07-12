import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { CanvasServer } from './canvas-server.js'
import { IntentQueue } from './intent-queue.js'

const stateFixture = readFileSync(
  new URL('../../core/test/fixtures/state.json', import.meta.url), 'utf8',
)

test('IntentQueue: take resolves when an intent is pushed later', async () => {
  const q = new IntentQueue()
  const taking = q.take(5000)
  q.push({ add: [], modify: [], remove: [{ address: 'aws_s3_bucket.x' }] })
  expect((await taking)?.remove[0]?.address).toBe('aws_s3_bucket.x')
})

test('IntentQueue: take times out with null', async () => {
  const q = new IntentQueue()
  expect(await q.take(50)).toBeNull()
})

let server: CanvasServer
afterEach(async () => { await server?.stop() })

test('POST /api/intent flows to awaitIntent; bad payload rejected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc-'))
  writeFileSync(join(dir, 'main.tf'), '')
  server = new CanvasServer({ dir, runTerraformShow: async () => stateFixture, portRangeStart: 17680 })
  const { url } = await server.start()
  const waiting = server.awaitIntent(5000)
  const good = await fetch(`${url}/api/intent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      add: [{ type: 'aws_db_instance', wishes: 'small', connect_to: ['aws_vpc.main'] }],
      modify: [], remove: [],
    }),
  })
  expect(good.status).toBe(202)
  const intent = await waiting
  expect(intent?.add[0]?.type).toBe('aws_db_instance')

  const bad = await fetch(`${url}/api/intent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nonsense: true }),
  })
  expect(bad.status).toBe(400)
})
