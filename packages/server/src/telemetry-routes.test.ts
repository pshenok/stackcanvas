import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { CanvasServer } from './canvas-server.js'
import { TelemetryClient } from './telemetry.js'

const stateFixture = readFileSync(
  new URL('../../core/test/fixtures/state.json', import.meta.url), 'utf8',
)

let server: CanvasServer
afterEach(async () => { await server?.stop() })

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'sc-'))
}

function makeTelemetryClient(): TelemetryClient {
  const dir = mkdtempSync(join(tmpdir(), 'sc-telemetry-routes-'))
  return new TelemetryClient({ configPath: join(dir, 'config.json'), appVersion: '0.1.0', env: {} })
}

test('GET /api/telemetry returns unset on a fresh config', async () => {
  const telemetry = makeTelemetryClient()
  server = new CanvasServer({
    dir: makeDir(), runTerraformShow: async () => stateFixture, portRangeStart: 20680, telemetry,
  })
  const { url } = await server.start()
  const res = await fetch(`${url}/api/telemetry`)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ consent: 'unset' })
})

test('POST /api/telemetry {granted:true} persists and GET reflects granted', async () => {
  const telemetry = makeTelemetryClient()
  server = new CanvasServer({
    dir: makeDir(), runTerraformShow: async () => stateFixture, portRangeStart: 20680, telemetry,
  })
  const { url } = await server.start()

  const postRes = await fetch(`${url}/api/telemetry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ granted: true }),
  })
  expect(postRes.status).toBe(200)
  expect(await postRes.json()).toEqual({ consent: 'granted' })

  const getRes = await fetch(`${url}/api/telemetry`)
  expect(await getRes.json()).toEqual({ consent: 'granted' })
})

test('POST /api/telemetry {granted:false} persists denied', async () => {
  const telemetry = makeTelemetryClient()
  server = new CanvasServer({
    dir: makeDir(), runTerraformShow: async () => stateFixture, portRangeStart: 20680, telemetry,
  })
  const { url } = await server.start()

  const postRes = await fetch(`${url}/api/telemetry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ granted: false }),
  })
  expect(postRes.status).toBe(200)
  expect(await postRes.json()).toEqual({ consent: 'denied' })

  const getRes = await fetch(`${url}/api/telemetry`)
  expect(await getRes.json()).toEqual({ consent: 'denied' })
})

test('POST /api/telemetry with a malformed body is rejected', async () => {
  const telemetry = makeTelemetryClient()
  server = new CanvasServer({
    dir: makeDir(), runTerraformShow: async () => stateFixture, portRangeStart: 20680, telemetry,
  })
  const { url } = await server.start()
  const res = await fetch(`${url}/api/telemetry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ granted: 'yes' }),
  })
  expect(res.status).toBe(400)
})

test('CanvasServer without an injected telemetry client still serves /api/telemetry', async () => {
  // Keep this hermetic: default TelemetryClient falls back to process.env, so
  // point it at a throwaway dir rather than touching the real ~/.stackcanvas.
  const dir = mkdtempSync(join(tmpdir(), 'sc-telemetry-default-'))
  const prev = process.env.STACKCANVAS_CONFIG_DIR
  process.env.STACKCANVAS_CONFIG_DIR = dir
  try {
    server = new CanvasServer({ dir: makeDir(), runTerraformShow: async () => stateFixture, portRangeStart: 20680 })
    const { url } = await server.start()
    const res = await fetch(`${url}/api/telemetry`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ consent: 'unset' })
  } finally {
    if (prev === undefined) delete process.env.STACKCANVAS_CONFIG_DIR
    else process.env.STACKCANVAS_CONFIG_DIR = prev
  }
})
