import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { CanvasServer } from './canvas-server.js'
import { nodesBucket, TelemetryClient, type TelemetryProps } from './telemetry.js'

const stateFixture = readFileSync(
  new URL('../../core/test/fixtures/state.json', import.meta.url), 'utf8',
)

let server: CanvasServer
afterEach(async () => { await server?.stop() })

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'sc-'))
}

function makeTelemetryClient(fetchImpl?: typeof fetch): TelemetryClient {
  const dir = mkdtempSync(join(tmpdir(), 'sc-telemetry-routes-'))
  // Default transport is real `fetch` (M1-6): tests that grant consent must
  // stub fetchImpl themselves to stay hermetic. Callers that only exercise
  // GET/consent-denied paths can omit it — emit() never fires there anyway.
  return new TelemetryClient({
    configPath: join(dir, 'config.json'), appVersion: '0.1.0', env: {},
    fetchImpl: fetchImpl ?? (async () => new Response(null, { status: 204 })),
  })
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

// ---------------------------------------------------------------------------
// canvas_opened — emitted from CanvasServer.start()
// ---------------------------------------------------------------------------

test('canvas_opened is emitted from start() once consent is granted', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))
  const telemetry = makeTelemetryClient(fetchImpl)
  telemetry.setConsent(true)
  fetchImpl.mockClear() // drop the 'install' call from setConsent above

  server = new CanvasServer({
    dir: makeDir(), runTerraformShow: async () => stateFixture, portRangeStart: 20680, telemetry,
  })
  await server.start()

  expect(fetchImpl).toHaveBeenCalledTimes(1)
  const [, init] = fetchImpl.mock.calls[0]!
  const envelope = JSON.parse(String(init!.body)) as { payload: TelemetryProps }
  expect(envelope.payload).toEqual({
    event: 'canvas_opened',
    nodes_bucket: nodesBucket(server.getGraph().nodes.length),
    tf_bin: 'unknown', // resolveTfBinary/TerraformProvider ships with the source-provider section
  })
})

test('canvas_opened is NOT emitted from start() when consent is unset', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))
  const telemetry = makeTelemetryClient(fetchImpl)
  server = new CanvasServer({
    dir: makeDir(), runTerraformShow: async () => stateFixture, portRangeStart: 20680, telemetry,
  })
  await server.start()
  expect(fetchImpl).not.toHaveBeenCalled()
})

test('no event before consent: CanvasServer.start() + POST /api/intent with the real default TelemetryClient (temp STACKCANVAS_CONFIG_DIR) makes zero telemetry network attempts', async () => {
  // No injected telemetry, no injected fetchImpl — this exercises the
  // actual production default (real global fetch), scoped to a hermetic
  // temp config dir. Passive spy (no mockImplementation) so the test's own
  // localhost requests to the server-under-test still go through for real.
  const configDir = mkdtempSync(join(tmpdir(), 'sc-real-default-'))
  const realFetchSpy = vi.spyOn(globalThis, 'fetch')
  const prev = process.env.STACKCANVAS_CONFIG_DIR
  process.env.STACKCANVAS_CONFIG_DIR = configDir
  try {
    server = new CanvasServer({ dir: makeDir(), runTerraformShow: async () => stateFixture, portRangeStart: 20680 })
    const { url } = await server.start() // would emit canvas_opened if consent were granted
    await fetch(`${url}/api/intent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ add: [], modify: [], remove: [] }),
    })
    const telemetryCalls = realFetchSpy.mock.calls.filter(([input]) => String(input).includes('stackcanvas.dev'))
    expect(telemetryCalls).toHaveLength(0)
  } finally {
    realFetchSpy.mockRestore()
    if (prev === undefined) delete process.env.STACKCANVAS_CONFIG_DIR
    else process.env.STACKCANVAS_CONFIG_DIR = prev
  }
})

// ---------------------------------------------------------------------------
// intent_sent — emitted from POST /api/intent, counted by action kind
// ---------------------------------------------------------------------------

test('POST /api/intent emits intent_sent with correct per-kind counts once consent is granted', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))
  const telemetry = makeTelemetryClient(fetchImpl)
  telemetry.setConsent(true)
  fetchImpl.mockClear()

  server = new CanvasServer({
    dir: makeDir(), runTerraformShow: async () => stateFixture, portRangeStart: 20680, telemetry,
  })
  const { url } = await server.start()
  fetchImpl.mockClear() // drop canvas_opened emitted by start() above

  const res = await fetch(`${url}/api/intent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      add: [
        { type: 'aws_db_instance', wishes: 'small', connect_to: [] },
        { type: 'aws_s3_bucket', wishes: '', connect_to: [] },
      ],
      modify: [{ address: 'aws_instance.web', wishes: 'bigger' }],
      remove: [],
    }),
  })
  expect(res.status).toBe(202)

  expect(fetchImpl).toHaveBeenCalledTimes(1)
  const [, init] = fetchImpl.mock.calls[0]!
  const envelope = JSON.parse(String(init!.body)) as { payload: TelemetryProps }
  expect(envelope.payload).toEqual({
    event: 'intent_sent', add: 2, modify: 1, remove: 0, adopt: 0, investigate: 0,
  })
})

test('POST /api/intent does NOT emit intent_sent when consent is unset', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))
  const telemetry = makeTelemetryClient(fetchImpl)
  server = new CanvasServer({
    dir: makeDir(), runTerraformShow: async () => stateFixture, portRangeStart: 20680, telemetry,
  })
  const { url } = await server.start()
  await fetch(`${url}/api/intent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ add: [], modify: [], remove: [] }),
  })
  expect(fetchImpl).not.toHaveBeenCalled()
})

test('POST /api/intent with an invalid body is rejected and never emits intent_sent', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))
  const telemetry = makeTelemetryClient(fetchImpl)
  telemetry.setConsent(true)
  server = new CanvasServer({
    dir: makeDir(), runTerraformShow: async () => stateFixture, portRangeStart: 20680, telemetry,
  })
  const { url } = await server.start()
  fetchImpl.mockClear()
  const res = await fetch(`${url}/api/intent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nonsense: true }),
  })
  expect(res.status).toBe(400)
  expect(fetchImpl).not.toHaveBeenCalled()
})

// ---------------------------------------------------------------------------
// POST /api/telemetry/event — the browser-originated forwarding route
// ---------------------------------------------------------------------------

test('POST /api/telemetry/event: allowlisted "drift_opened" forwards through TelemetryClient when consent is granted', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))
  const telemetry = makeTelemetryClient(fetchImpl)
  telemetry.setConsent(true)
  server = new CanvasServer({
    dir: makeDir(), runTerraformShow: async () => stateFixture, portRangeStart: 20680, telemetry,
  })
  const { url } = await server.start()
  fetchImpl.mockClear() // drop canvas_opened

  const res = await fetch(`${url}/api/telemetry/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'drift_opened' }),
  })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true })

  expect(fetchImpl).toHaveBeenCalledTimes(1)
  const [, init] = fetchImpl.mock.calls[0]!
  const envelope = JSON.parse(String(init!.body)) as { payload: TelemetryProps }
  expect(envelope.payload).toEqual({
    event: 'drift_opened', nodes_bucket: nodesBucket(server.getGraph().nodes.length),
  })
})

test('POST /api/telemetry/event: a name outside the browser-emittable allowlist is rejected with 400, nothing forwarded', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))
  const telemetry = makeTelemetryClient(fetchImpl)
  telemetry.setConsent(true)
  server = new CanvasServer({
    dir: makeDir(), runTerraformShow: async () => stateFixture, portRangeStart: 20680, telemetry,
  })
  const { url } = await server.start()
  fetchImpl.mockClear()

  // 'install' is a real event name, but not browser-emittable — a browser
  // must never be able to spoof server-only events through this route.
  const res = await fetch(`${url}/api/telemetry/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'install' }),
  })
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: 'unknown event' })
  expect(fetchImpl).not.toHaveBeenCalled()
})

test('POST /api/telemetry/event: missing/non-string name is rejected with 400', async () => {
  server = new CanvasServer({
    dir: makeDir(), runTerraformShow: async () => stateFixture, portRangeStart: 20680,
    telemetry: makeTelemetryClient(),
  })
  const { url } = await server.start()
  const res = await fetch(`${url}/api/telemetry/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  expect(res.status).toBe(400)
})

test('POST /api/telemetry/event: consent unset still returns 200 {ok:true} (never leaks consent state) but emits nothing', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))
  const telemetry = makeTelemetryClient(fetchImpl)
  server = new CanvasServer({
    dir: makeDir(), runTerraformShow: async () => stateFixture, portRangeStart: 20680, telemetry,
  })
  const { url } = await server.start()

  const res = await fetch(`${url}/api/telemetry/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'drift_opened' }),
  })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true })
  expect(fetchImpl).not.toHaveBeenCalled()
})

test('POST /api/telemetry/event: consent denied returns 200 {ok:true} and emits nothing', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))
  const telemetry = makeTelemetryClient(fetchImpl)
  telemetry.setConsent(true)
  telemetry.setConsent(false)
  server = new CanvasServer({
    dir: makeDir(), runTerraformShow: async () => stateFixture, portRangeStart: 20680, telemetry,
  })
  const { url } = await server.start()
  fetchImpl.mockClear()

  const res = await fetch(`${url}/api/telemetry/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'drift_opened' }),
  })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true })
  expect(fetchImpl).not.toHaveBeenCalled()
})

// ---------------------------------------------------------------------------
// DO_NOT_TRACK end-to-end
// ---------------------------------------------------------------------------

test('DO_NOT_TRACK=1 end-to-end: GET /api/telemetry reports disabled_env and no emitter fires, even with a pre-granted config', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc-dnt-'))
  const configPath = join(dir, 'config.json')
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))

  // Pre-seed a granted config to prove the env kill-switch wins regardless
  // of what's already on disk.
  const seeder = new TelemetryClient({ configPath, appVersion: '0.1.0', env: {}, fetchImpl })
  seeder.setConsent(true)
  fetchImpl.mockClear()

  const telemetry = new TelemetryClient({
    configPath, appVersion: '0.1.0', env: { DO_NOT_TRACK: '1' }, fetchImpl,
  })
  server = new CanvasServer({
    dir: makeDir(), runTerraformShow: async () => stateFixture, portRangeStart: 20680, telemetry,
  })
  const { url } = await server.start() // would emit canvas_opened if not for DO_NOT_TRACK

  const consentRes = await fetch(`${url}/api/telemetry`)
  expect(await consentRes.json()).toEqual({ consent: 'disabled_env' })

  await fetch(`${url}/api/intent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      add: [{ type: 'aws_db_instance', wishes: '', connect_to: [] }], modify: [], remove: [],
    }),
  })
  await fetch(`${url}/api/telemetry/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'drift_opened' }),
  })

  expect(fetchImpl).not.toHaveBeenCalled()
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
