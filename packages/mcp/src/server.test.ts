import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CanvasServer } from '@stackcanvas/server'
import { afterEach, expect, test } from 'vitest'
import { createMcpServer } from './server.js'

const stateFixture = readFileSync(
  new URL('../../core/test/fixtures/state.json', import.meta.url), 'utf8',
)

let canvas: CanvasServer | undefined
afterEach(async () => { await canvas?.stop() })

async function connect() {
  const dir = mkdtempSync(join(tmpdir(), 'sc-'))
  writeFileSync(join(dir, 'main.tf'), '')
  const opened: string[] = []
  const mcp = createMcpServer({
    makeCanvas: d => {
      canvas = new CanvasServer({ dir: d, runTerraformShow: async () => stateFixture, portRangeStart: 18680 })
      return canvas
    },
    openBrowser: url => { opened.push(url) },
  })
  const client = new Client({ name: 'test', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)])
  return { client, dir, opened }
}

function text(result: unknown): string {
  return (result as { content: { text: string }[] }).content[0].text
}

test('open_canvas starts server, opens browser, returns URL', async () => {
  const { client, dir, opened } = await connect()
  const res = await client.callTool({ name: 'open_canvas', arguments: { dir } })
  expect(text(res)).toMatch(/http:\/\/127\.0\.0\.1:\d+/)
  expect(opened.length).toBe(1)
})

test('open_canvas rejects a non-terraform dir', async () => {
  const { client } = await connect()
  const empty = mkdtempSync(join(tmpdir(), 'sc-empty-'))
  const res = await client.callTool({ name: 'open_canvas', arguments: { dir: empty } })
  expect((res as { isError?: boolean }).isError).toBe(true)
  expect(text(res)).toContain('does not look like a Terraform root')
})

test('open_canvas recovers from a failed start instead of wedging', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc-'))
  writeFileSync(join(dir, 'main.tf'), '')
  let attempt = 0
  const mcp = createMcpServer({
    makeCanvas: d => {
      attempt += 1
      const instance = new CanvasServer({ dir: d, runTerraformShow: async () => stateFixture })
      if (attempt === 1) {
        instance.start = async () => { throw new Error('port exhausted') }
      } else {
        canvas = instance
      }
      return instance
    },
  })
  const client = new Client({ name: 'test', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)])

  const first = await client.callTool({ name: 'open_canvas', arguments: { dir } })
  expect((first as { isError?: boolean }).isError).toBe(true)
  expect(text(first)).toContain('Failed to start canvas')

  const second = await client.callTool({ name: 'open_canvas', arguments: { dir } })
  expect((second as { isError?: boolean }).isError).toBeFalsy()
  expect(text(second)).toMatch(/http:\/\/127\.0\.0\.1:\d+/)
  expect(text(second)).not.toContain('null')
})

test('get_graph_summary returns the summary text', async () => {
  const { client, dir } = await connect()
  await client.callTool({ name: 'open_canvas', arguments: { dir } })
  const res = await client.callTool({ name: 'get_graph_summary', arguments: {} })
  expect(text(res)).toContain('resources')
})

const NO_TF_BINARY_MESSAGE = 'No terraform or tofu binary found in PATH. Install one or set STACKCANVAS_TF_BIN.'

async function connectStale() {
  const dir = mkdtempSync(join(tmpdir(), 'sc-'))
  writeFileSync(join(dir, 'main.tf'), '')
  const mcp = createMcpServer({
    makeCanvas: d => {
      canvas = new CanvasServer({
        dir: d,
        runTerraformShow: async () => { throw new Error(NO_TF_BINARY_MESSAGE) },
        portRangeStart: 18680,
      })
      return canvas
    },
  })
  const client = new Client({ name: 'test', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)])
  return { client, dir }
}

test('open_canvas warns the agent when the graph is stale', async () => {
  const { client, dir } = await connectStale()
  const res = await client.callTool({ name: 'open_canvas', arguments: { dir } })
  expect((res as { isError?: boolean }).isError).toBeFalsy()
  expect(text(res)).toContain('WARNING')
  expect(text(res)).toContain(NO_TF_BINARY_MESSAGE)
})

test('get_graph_summary warns the agent when the graph is stale', async () => {
  const { client, dir } = await connectStale()
  await client.callTool({ name: 'open_canvas', arguments: { dir } })
  const res = await client.callTool({ name: 'get_graph_summary', arguments: {} })
  expect(text(res)).toContain('WARNING')
  expect(text(res)).toContain(NO_TF_BINARY_MESSAGE)
})

test('await_canvas_intent returns queued intent as JSON', async () => {
  const { client, dir } = await connect()
  const openRes = await client.callTool({ name: 'open_canvas', arguments: { dir } })
  const url = text(openRes).match(/http:\/\/127\.0\.0\.1:\d+/)![0]
  const waiting = client.callTool({
    name: 'await_canvas_intent', arguments: { timeoutSeconds: 10 },
  })
  await fetch(`${url}/api/intent`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ add: [], modify: [], remove: [{ address: 'aws_vpc.main' }] }),
  })
  const res = await waiting
  expect(JSON.parse(text(res)).intent.remove[0].address).toBe('aws_vpc.main')
})

test('await_canvas_intent times out with null intent', async () => {
  const { client, dir } = await connect()
  await client.callTool({ name: 'open_canvas', arguments: { dir } })
  const res = await client.callTool({
    name: 'await_canvas_intent', arguments: { timeoutSeconds: 0.1 },
  })
  expect(JSON.parse(text(res)).intent).toBeNull()
})
