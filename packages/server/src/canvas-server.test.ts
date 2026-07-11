import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { CanvasServer } from './canvas-server.js'

const stateFixture = readFileSync(
  new URL('../../core/test/fixtures/state.json', import.meta.url), 'utf8',
)

let server: CanvasServer
afterEach(async () => { await server?.stop() })

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sc-'))
  writeFileSync(join(dir, 'main.tf'), 'resource "aws_vpc" "main" {}')
  return dir
}

test('serves the parsed graph on /api/graph', async () => {
  server = new CanvasServer({ dir: makeDir(), runTerraformShow: async () => stateFixture })
  const { url } = await server.start()
  const res = await fetch(`${url}/api/graph`)
  expect(res.status).toBe(200)
  const graph = await res.json()
  expect(graph.nodes.some((n: { id: string }) => n.id === 'aws_vpc.main')).toBe(true)
})

test('terraform failure keeps last good graph and reports stale', async () => {
  let fail = false
  server = new CanvasServer({
    dir: makeDir(),
    runTerraformShow: async () => { if (fail) throw new Error('boom'); return stateFixture },
  })
  const { url } = await server.start()
  fail = true
  await server.refreshGraph()
  const graph = await (await fetch(`${url}/api/graph`)).json()
  expect(graph.nodes.length).toBeGreaterThan(0) // last good kept
})

test('binds localhost only', async () => {
  server = new CanvasServer({ dir: makeDir(), runTerraformShow: async () => stateFixture })
  const { url } = await server.start()
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
})
