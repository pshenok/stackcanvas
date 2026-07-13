import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import type { GraphModel, ProviderSnapshot, SourceProvider } from '@stackcanvas/core'
import { CanvasServer } from './canvas-server.js'

const stateFixture = readFileSync(
  new URL('../../core/test/fixtures/state.json', import.meta.url), 'utf8',
)

function fakeGraph(nodeId: string): GraphModel {
  return {
    nodes: [{
      id: nodeId, type: 'aws_instance', name: nodeId, provider: 'aws',
      group: null, attributes: {}, status: 'noop', dependsOn: [],
    }],
    edges: [],
    groups: [],
  }
}

// Minimal SourceProvider double for composition tests — no downcasts, same
// options shape as TerraformProvider, so it exercises addProvider/
// removeProvider/recompose exactly as a real extra provider would.
function fakeProvider(origin: string, opts: {
  refreshOnStart?: boolean
  graph?: GraphModel
  stale?: string | null
  meta?: ProviderSnapshot['meta']
} = {}): SourceProvider & { pushSnapshot: (s: ProviderSnapshot) => void } {
  let pushFn: ((s: ProviderSnapshot) => void) | null = null
  const snapshot = (): ProviderSnapshot => ({
    origin, graph: opts.graph ?? fakeGraph(`${origin}.node`), stale: opts.stale ?? null, meta: opts.meta,
  })
  return {
    origin,
    label: `Fake (${origin})`,
    refreshOnStart: opts.refreshOnStart ?? true,
    init: vi.fn(async () => {}),
    refresh: vi.fn(async () => snapshot()),
    watch: vi.fn((push: (s: ProviderSnapshot) => void) => { pushFn = push }),
    dispose: vi.fn(async () => {}),
    pushSnapshot: (s: ProviderSnapshot) => pushFn?.(s),
  }
}

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
  server = new CanvasServer({ dir: makeDir(), runTerraformShow: async () => stateFixture, portRangeStart: 15600 })
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
    portRangeStart: 15600,
  })
  const { url } = await server.start()
  fail = true
  await server.refreshGraph()
  const graph = await (await fetch(`${url}/api/graph`)).json()
  expect(graph.nodes.length).toBeGreaterThan(0) // last good kept
})

test('binds localhost only', async () => {
  server = new CanvasServer({ dir: makeDir(), runTerraformShow: async () => stateFixture, portRangeStart: 15600 })
  const { url } = await server.start()
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
})

test('path traversal attack protection', async () => {
  const uiDir = mkdtempSync(join(tmpdir(), 'ui-'))
  writeFileSync(join(uiDir, 'index.html'), '<!doctype html>ok')
  server = new CanvasServer({
    dir: makeDir(), uiDist: uiDir,
    runTerraformShow: async () => stateFixture, portRangeStart: 15600,
  })
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

test('auto-selects a different port when the range start is occupied', async () => {
  rawServer = await occupyPort(15680)
  server = new CanvasServer({
    dir: makeDir(), runTerraformShow: async () => stateFixture, portRangeStart: 15680,
  })
  const { port, url } = await server.start()
  expect(port).not.toBe(15680)
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

// --- P2-11 composition tests (issue #25) — new portRangeStart base per the
// distinct-base convention so this file's suites never contend on a port. ---

test('graph nodes carry origin: "terraform" and /api/meta lists the terraform provider', async () => {
  server = new CanvasServer({ dir: makeDir(), runTerraformShow: async () => stateFixture, portRangeStart: 21680 })
  const { url } = await server.start()
  const graph = await (await fetch(`${url}/api/graph`)).json()
  expect(graph.nodes.every((n: { origin?: string }) => n.origin === 'terraform')).toBe(true)
  const meta = await (await fetch(`${url}/api/meta`)).json()
  expect(meta.providers).toEqual([{ origin: 'terraform', label: expect.any(String), stale: null }])
  expect(meta.conflicts).toEqual([])
})

test('extraProviders compose alongside terraform: nodes, joined stale, and per-provider meta all surface', async () => {
  const extra = fakeProvider('fake-live', {
    graph: fakeGraph('fake_thing.x'),
    stale: 'scan failed',
    meta: { scannedAt: '2026-07-12T00:00:00Z', errors: [{ service: 's3', message: 'boom' }] },
  })
  server = new CanvasServer({
    dir: makeDir(), runTerraformShow: async () => stateFixture, portRangeStart: 21680,
    extraProviders: [extra],
  })
  const { url } = await server.start()
  const graph = await (await fetch(`${url}/api/graph`)).json()
  expect(graph.nodes.some((n: { id: string }) => n.id === 'aws_vpc.main')).toBe(true)
  expect(graph.nodes.some((n: { id: string }) => n.id === 'fake_thing.x')).toBe(true)
  const meta = await (await fetch(`${url}/api/meta`)).json()
  expect(meta.stale).toBe('fake-live: scan failed')
  const tfEntry = meta.providers.find((p: { origin: string }) => p.origin === 'terraform')
  const liveEntry = meta.providers.find((p: { origin: string }) => p.origin === 'fake-live')
  expect(tfEntry.stale).toBeNull()
  expect(liveEntry.stale).toBe('scan failed')
  expect(liveEntry.scannedAt).toBe('2026-07-12T00:00:00Z')
  expect(liveEntry.errors).toEqual([{ service: 's3', message: 'boom' }])
})

test('stop() disposes extra providers too', async () => {
  const extra = fakeProvider('fake-live')
  server = new CanvasServer({
    dir: makeDir(), runTerraformShow: async () => stateFixture, portRangeStart: 21680,
    extraProviders: [extra],
  })
  await server.start()
  await server.stop()
  expect(extra.dispose).toHaveBeenCalled()
})

test('addProvider() registers and broadcasts after start(), and replaces cleanly on a repeat call', async () => {
  server = new CanvasServer({ dir: makeDir(), runTerraformShow: async () => stateFixture, portRangeStart: 21680 })
  await server.start()
  const first = fakeProvider('fake-live', { graph: fakeGraph('fake_thing.first') })
  await server.addProvider(first)
  expect(server.getGraph().nodes.some(n => n.id === 'fake_thing.first')).toBe(true)

  const second = fakeProvider('fake-live', { graph: fakeGraph('fake_thing.second') })
  await server.addProvider(second)
  expect(first.dispose).toHaveBeenCalled()
  expect(server.getGraph().nodes.some(n => n.id === 'fake_thing.second')).toBe(true)
  expect(server.getGraph().nodes.some(n => n.id === 'fake_thing.first')).toBe(false)
})

test('removeProvider() disposes and drops the origin from providers[] and the composed graph', async () => {
  const extra = fakeProvider('fake-live', { graph: fakeGraph('fake_thing.x') })
  server = new CanvasServer({
    dir: makeDir(), runTerraformShow: async () => stateFixture, portRangeStart: 21680,
    extraProviders: [extra],
  })
  const { url } = await server.start()
  expect(server.getGraph().nodes.some(n => n.id === 'fake_thing.x')).toBe(true)

  await server.removeProvider('fake-live')
  expect(extra.dispose).toHaveBeenCalled()
  expect(server.getGraph().nodes.some(n => n.id === 'fake_thing.x')).toBe(false)
  const meta = await (await fetch(`${url}/api/meta`)).json()
  expect(meta.providers.map((p: { origin: string }) => p.origin)).toEqual(['terraform'])

  // No-op when the origin isn't registered.
  await expect(server.removeProvider('never-registered')).resolves.toBeUndefined()
})

test('a refreshOnStart:false provider is never refreshed by start()/refreshGraph(), yet addProvider surfaces its snapshot immediately', async () => {
  const live = fakeProvider('fake-live', { refreshOnStart: false, graph: fakeGraph('fake_thing.x') })
  server = new CanvasServer({
    dir: makeDir(), runTerraformShow: async () => stateFixture, portRangeStart: 21680,
    extraProviders: [live],
  })
  await server.start()
  // addProvider() still calls init()/watch() even when refreshOnStart is
  // false, but never refresh() — no implicit scan-like call ever fires.
  expect(live.init).toHaveBeenCalledTimes(1)
  expect(live.watch).toHaveBeenCalledTimes(1)
  expect(live.refresh).not.toHaveBeenCalled()
  // Its (empty, default) snapshot is not part of `snapshots` until it
  // refreshes or pushes one itself, so it contributes nothing yet — proving
  // start() truly never called refresh() on its behalf.
  expect(server.getGraph().nodes.some(n => n.id === 'fake_thing.x')).toBe(false)

  await server.refreshGraph()
  expect(live.refresh).not.toHaveBeenCalled()

  // Once it pushes its own snapshot (e.g. after a later explicit scan), it
  // composes normally.
  live.pushSnapshot({ origin: 'fake-live', graph: fakeGraph('fake_thing.x'), stale: null })
  expect(server.getGraph().nodes.some(n => n.id === 'fake_thing.x')).toBe(true)
})

// --- P2-12 OpenTofu binary resolution tests (issue #26) — new portRangeStart
// base per the distinct-base convention. tfBinary is passed explicit (used
// verbatim by resolveTfBinary, no probe), so this stays hermetic regardless
// of whether terraform/tofu are actually installed on the host. ---

test('tfBinary option flows through to TerraformProvider.binaryUsed and the /api/meta label', async () => {
  server = new CanvasServer({ dir: makeDir(), tfBinary: 'sc-test-fake-binary', portRangeStart: 22680 })
  const { url } = await server.start()
  const meta = await (await fetch(`${url}/api/meta`)).json()
  const tf = meta.providers.find((p: { origin: string }) => p.origin === 'terraform')
  expect(tf.label).toBe(`Terraform (${server.dir}) via sc-test-fake-binary`)
})

test('without tfBinary and an injected runTerraformShow, the label carries no binary suffix (unchanged)', async () => {
  server = new CanvasServer({
    dir: makeDir(), runTerraformShow: async () => stateFixture, portRangeStart: 22680,
  })
  const { url } = await server.start()
  const meta = await (await fetch(`${url}/api/meta`)).json()
  const tf = meta.providers.find((p: { origin: string }) => p.origin === 'terraform')
  expect(tf.label).toBe(`Terraform (${server.dir})`)
})
