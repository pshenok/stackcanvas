import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
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

const validIntentBody = JSON.stringify({
  add: [{ type: 'aws_db_instance', wishes: 'small', connect_to: ['aws_vpc.main'] }],
  modify: [], remove: [],
})

interface RawResponse { status: number; body: string }

// fetch() silently ignores an overridden Host header (undici treats it as a
// forbidden header name and substitutes the real connection target), so Host
// spoofing must go through node:http directly, which sends whatever Host is given.
function rawRequest(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<RawResponse> {
  return new Promise((resolveP, reject) => {
    const u = new URL(url)
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: opts.method ?? 'GET',
      headers: opts.headers,
    }, res => {
      let data = ''
      res.on('data', (chunk: Buffer) => { data += chunk.toString() })
      res.on('end', () => resolveP({ status: res.statusCode ?? 0, body: data }))
    })
    req.once('error', reject)
    if (opts.body) req.write(opts.body)
    req.end()
  })
}

test('POST /api/intent with spoofed Host header is rejected', async () => {
  server = new CanvasServer({ dir: makeDir(), runTerraformShow: async () => stateFixture, portRangeStart: 19680 })
  const { url } = await server.start()
  const res = await rawRequest(`${url}/api/intent`, {
    method: 'POST',
    headers: { Host: 'evil.com', 'content-type': 'application/json' },
    body: validIntentBody,
  })
  expect(res.status).toBe(403)
  expect(JSON.parse(res.body)).toEqual({ error: 'forbidden origin' })
})

test('POST /api/intent with spoofed Origin is rejected even with a valid Host', async () => {
  server = new CanvasServer({ dir: makeDir(), runTerraformShow: async () => stateFixture, portRangeStart: 19680 })
  const { url, port } = await server.start()
  const res = await rawRequest(`${url}/api/intent`, {
    method: 'POST',
    headers: { Host: `127.0.0.1:${port}`, Origin: 'http://evil.com', 'content-type': 'application/json' },
    body: validIntentBody,
  })
  expect(res.status).toBe(403)
  expect(JSON.parse(res.body)).toEqual({ error: 'forbidden origin' })
})

test('POST /api/intent with valid Host and matching localhost Origin passes the guard', async () => {
  server = new CanvasServer({ dir: makeDir(), runTerraformShow: async () => stateFixture, portRangeStart: 19680 })
  const { url, port } = await server.start()
  const res = await fetch(`${url}/api/intent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: `http://127.0.0.1:${port}` },
    body: validIntentBody,
  })
  expect(res.status).toBe(202)
})

test('POST /api/intent with valid Host and no Origin passes the guard (curl case)', async () => {
  server = new CanvasServer({ dir: makeDir(), runTerraformShow: async () => stateFixture, portRangeStart: 19680 })
  const { url } = await server.start()
  const res = await fetch(`${url}/api/intent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: validIntentBody,
  })
  expect(res.status).toBe(202)
})

test('GET /api/graph is unaffected by a spoofed Host header (guard is POST-only)', async () => {
  server = new CanvasServer({ dir: makeDir(), runTerraformShow: async () => stateFixture, portRangeStart: 19680 })
  const { url } = await server.start()
  const res = await rawRequest(`${url}/api/graph`, { headers: { Host: 'evil.com' } })
  expect(res.status).toBe(200)
})

test('POST /api/intent with a "localhost" Host header is accepted', async () => {
  server = new CanvasServer({ dir: makeDir(), runTerraformShow: async () => stateFixture, portRangeStart: 19680 })
  const { port } = await server.start()
  const res = await rawRequest(`http://127.0.0.1:${port}/api/intent`, {
    method: 'POST',
    headers: { Host: `localhost:${port}`, 'content-type': 'application/json' },
    body: validIntentBody,
  })
  expect(res.status).toBe(202)
})

test('POST /api/telemetry with spoofed Host header is rejected by the same guard', async () => {
  server = new CanvasServer({ dir: makeDir(), runTerraformShow: async () => stateFixture, portRangeStart: 19680 })
  const { url } = await server.start()
  const res = await rawRequest(`${url}/api/telemetry`, {
    method: 'POST',
    headers: { Host: 'evil.com', 'content-type': 'application/json' },
    body: JSON.stringify({ granted: true }),
  })
  expect(res.status).toBe(403)
  expect(JSON.parse(res.body)).toEqual({ error: 'forbidden origin' })
})
