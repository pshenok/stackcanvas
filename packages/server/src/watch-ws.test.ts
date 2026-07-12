import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import WebSocket from 'ws'
import { CanvasServer } from './canvas-server.js'

const stateFixture = readFileSync(
  new URL('../../core/test/fixtures/state.json', import.meta.url), 'utf8',
)
const planFixture = readFileSync(
  new URL('../../core/test/fixtures/plan.json', import.meta.url), 'utf8',
)

let server: CanvasServer
afterEach(async () => { await server?.stop() })

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise(resolve => ws.once('message', d => resolve(JSON.parse(d.toString()))))
}

test('pushes graph on connect and again when tfstate changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc-'))
  writeFileSync(join(dir, 'main.tf'), '')
  writeFileSync(join(dir, 'terraform.tfstate'), '{}')
  server = new CanvasServer({ dir, runTerraformShow: async () => stateFixture, portRangeStart: 16680 })
  const { url } = await server.start()
  const ws = new WebSocket(`${url.replace('http', 'ws')}/ws`)
  const first = await nextMessage(ws)
  expect(first['type']).toBe('graph')
  const changed = nextMessage(ws)
  writeFileSync(join(dir, 'terraform.tfstate'), '{"serial": 2}')
  const msg = await changed
  expect(msg['type']).toBe('graph')
  ws.close()
}, 15000)

test('loadPlan applies diff statuses to the served graph', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc-'))
  writeFileSync(join(dir, 'main.tf'), '')
  mkdirSync(join(dir, '.stackcanvas'))
  const planPath = join(dir, '.stackcanvas', 'plan.json')
  writeFileSync(planPath, planFixture)
  server = new CanvasServer({ dir, runTerraformShow: async () => stateFixture, portRangeStart: 16680 })
  const { url } = await server.start()
  await server.loadPlan(planPath)
  const graph = await (await fetch(`${url}/api/graph`)).json()
  const web = graph.nodes.find((n: { id: string }) => n.id === 'aws_instance.web')
  expect(web.status).toBe('update')
})

test('restarting the same instance does not duplicate broadcasts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc-'))
  writeFileSync(join(dir, 'main.tf'), '')
  server = new CanvasServer({ dir, runTerraformShow: async () => stateFixture, portRangeStart: 16680 })
  await server.start()
  await server.stop()
  const { url } = await server.start()
  const ws = new WebSocket(`${url.replace('http', 'ws')}/ws`)
  const messages: { type: string }[] = []
  ws.on('message', d => messages.push(JSON.parse(d.toString())))
  await new Promise(r => ws.once('open', r))
  await new Promise(r => setTimeout(r, 150))
  const before = messages.filter(m => m.type === 'graph').length
  await server.refreshGraph()
  await new Promise(r => setTimeout(r, 150))
  const after = messages.filter(m => m.type === 'graph').length
  expect(after - before).toBe(1)
  ws.close()
})

test('malformed plan.json sets stale instead of crashing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc-'))
  writeFileSync(join(dir, 'main.tf'), '')
  mkdirSync(join(dir, '.stackcanvas'))
  server = new CanvasServer({ dir, runTerraformShow: async () => stateFixture, portRangeStart: 16680 })
  await server.start()
  writeFileSync(join(dir, '.stackcanvas', 'plan.json'), '{ not json')
  await new Promise(r => setTimeout(r, 800))
  expect(server.getStale()).toBeTruthy()
  const g = server.getGraph()
  expect(g.nodes.length).toBeGreaterThan(0)
}, 15000)
