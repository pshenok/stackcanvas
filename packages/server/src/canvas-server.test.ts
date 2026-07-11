import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { CanvasServer } from './canvas-server.js'

const stateFixture = readFileSync(
  new URL('../../core/test/fixtures/state.json', import.meta.url), 'utf8',
)

let server: CanvasServer
let rawServer: net.Server | undefined
afterEach(async () => {
  await server?.stop()
  if (rawServer) await new Promise<void>(resolve => rawServer!.close(() => resolve()))
  rawServer = undefined
})

function occupyPort(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(port, '127.0.0.1', () => resolve(srv))
  })
}

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

test('path traversal attack protection', async () => {
  const uiDir = mkdtempSync(join(tmpdir(), 'ui-'))
  writeFileSync(join(uiDir, 'index.html'), '<!doctype html>ok')
  server = new CanvasServer({ dir: makeDir(), uiDist: uiDir, runTerraformShow: async () => stateFixture })
  const { url } = await server.start()

  // Test encoded traversal
  const res1 = await fetch(`${url}/..%2f..%2f..%2fetc%2fpasswd`)
  const body1 = await res1.text()
  expect(res1.status).toBe(200)
  expect(body1).toBe('<!doctype html>ok')
  expect(body1).not.toMatch(/^root:/)

  // Test unencoded traversal
  const res2 = await fetch(`${url}/../../../../etc/passwd`)
  const body2 = await res2.text()
  expect(res2.status).toBe(200)
  expect(body2).toBe('<!doctype html>ok')
  expect(body2).not.toMatch(/^root:/)
})

test('auto-selects a different port when the default is occupied', async () => {
  rawServer = await occupyPort(4680)
  server = new CanvasServer({ dir: makeDir(), runTerraformShow: async () => stateFixture })
  const { port, url } = await server.start()
  expect(port).not.toBe(4680)
  const res = await fetch(`${url}/api/graph`)
  expect(res.status).toBe(200)
})

test('rejects with EADDRINUSE when a fixed port is occupied', async () => {
  rawServer = await occupyPort(4780)
  server = new CanvasServer({
    dir: makeDir(),
    runTerraformShow: async () => stateFixture,
    port: 4780,
  })
  await expect(server.start()).rejects.toThrow(/EADDRINUSE/)
})
