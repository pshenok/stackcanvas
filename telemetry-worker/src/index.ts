// stackcanvas telemetry collector — M1-7 / issue #11.
//
// See docs/SPEC.md, "Telemetry, CI matrix, release & registry engineering"
// chapter, §Design/1 ("Transport decision") for the design this implements,
// and the repo-root TELEMETRY.md for the user-facing contract. This worker
// is the *only* vendor-side endpoint stackcanvas' own code ever calls out to.
//
// Routes:
//   POST /e       validate + store an envelope, 204 on success
//   GET  /health  liveness check, always 200
//   *    *        404 (this includes GET /e, and any CORS preflight OPTIONS
//                  request — there is no browser client for this endpoint,
//                  only server-side `fetch` calls from stackcanvas itself,
//                  so no CORS headers are ever set and preflights are simply
//                  unmatched routes)
//
// Storage: Workers Analytics Engine (aggregate counters, ~90-day retention)
// + a raw-envelope NDJSON mirror in R2 (long-term system of record), per the
// chapter's explicit "PostHog vs Cloudflare Worker" transport decision. Both
// writes are best-effort — a storage failure never turns into an error
// response to the caller (see docs/SPEC.md "Error handling": "both fail →
// 204 anyway (client must never see backpressure)").
//
// The envelope/payload shapes below intentionally duplicate (rather than
// import) packages/server/src/telemetry.ts's types: this package is NOT
// part of the pnpm workspace (see package.json) and ships as a single
// bundled Worker with no monorepo dependency, so the collector's allowlist
// must be self-contained. Keep the two in sync by hand — TELEMETRY.md is the
// document of record for the schema either side must match.

export interface AnalyticsEngineDataset {
  writeDataPoint(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void
}

export interface R2Bucket {
  put(key: string, value: string): Promise<unknown>
}

export interface Env {
  /** Workers Analytics Engine binding — see wrangler.toml [[analytics_engine_datasets]]. */
  EVENTS: AnalyticsEngineDataset
  /** R2 bucket binding for the raw NDJSON mirror — see wrangler.toml [[r2_buckets]]. */
  BUCKET: R2Bucket
}

const MAX_BODY_BYTES = 4096

const NODES_BUCKETS = ['0', '1-10', '11-50', '51-200', '200+'] as const
const TF_BINS = ['terraform', 'tofu', 'unknown'] as const
const PROVIDERS = ['aws', 'gcp', 'azure', 'other'] as const
const PLATFORMS = ['darwin', 'linux', 'win32', 'other'] as const

type NodesBucket = (typeof NODES_BUCKETS)[number]
type TfBin = (typeof TF_BINS)[number]
type Provider = (typeof PROVIDERS)[number]
type Platform = (typeof PLATFORMS)[number]

export type TelemetryProps =
  | { event: 'install' }
  | { event: 'canvas_opened'; nodes_bucket: NodesBucket; tf_bin: TfBin }
  | { event: 'intent_sent'; add: number; modify: number; remove: number; adopt: number; investigate: number }
  | { event: 'scan_run'; provider: Provider; nodes_bucket: NodesBucket }
  | { event: 'drift_opened'; nodes_bucket: NodesBucket }

export interface TelemetryEnvelope {
  schema: 1
  anon_id: string
  day: string
  app_version: string
  platform: Platform
  node_major: number
  payload: TelemetryProps
}

/** Envelope allowlist — the "hard allowlist" the chapter requires: any key
 *  outside this set is a 400, not a silent strip (a stripping collector
 *  would mask exactly the accidental-field-growth bug this schema exists to
 *  catch — see the client-side "envelope allowlist tripwire" test this
 *  mirrors, packages/server/src/telemetry.test.ts). */
const ENVELOPE_KEYS = ['schema', 'anon_id', 'day', 'app_version', 'platform', 'node_major', 'payload'] as const

/** Per-event payload key allowlist — mirrors TelemetryProps above exactly. */
const PAYLOAD_KEYS: Record<TelemetryProps['event'], readonly string[]> = {
  install: ['event'],
  canvas_opened: ['event', 'nodes_bucket', 'tf_bin'],
  intent_sent: ['event', 'add', 'modify', 'remove', 'adopt', 'investigate'],
  scan_run: ['event', 'provider', 'nodes_bucket'],
  drift_opened: ['event', 'nodes_bucket'],
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

type ValidationResult = { ok: true; envelope: TelemetryEnvelope } | { ok: false; status: number; error: string }

function fail(status: number, error: string): { ok: false; status: number; error: string } {
  return { ok: false, status, error }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(obj: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(obj).every((key) => (allowed as readonly string[]).includes(key))
}

function isCappedCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 50
}

function validatePayload(payload: unknown): { ok: true; payload: TelemetryProps } | { ok: false; status: number; error: string } {
  if (!isRecord(payload)) return fail(400, 'invalid payload')

  const event = payload.event
  if (typeof event !== 'string' || !(event in PAYLOAD_KEYS)) return fail(400, 'unknown event')
  const eventName = event as TelemetryProps['event']

  if (!hasOnlyKeys(payload, PAYLOAD_KEYS[eventName])) return fail(400, 'unknown payload field')

  switch (eventName) {
    case 'install':
      return { ok: true, payload: { event: 'install' } }

    case 'canvas_opened': {
      const { nodes_bucket, tf_bin } = payload
      if (typeof nodes_bucket !== 'string' || !(NODES_BUCKETS as readonly string[]).includes(nodes_bucket)) {
        return fail(400, 'invalid nodes_bucket')
      }
      if (typeof tf_bin !== 'string' || !(TF_BINS as readonly string[]).includes(tf_bin)) {
        return fail(400, 'invalid tf_bin')
      }
      return { ok: true, payload: { event: 'canvas_opened', nodes_bucket: nodes_bucket as NodesBucket, tf_bin: tf_bin as TfBin } }
    }

    case 'intent_sent': {
      const { add, modify, remove, adopt, investigate } = payload
      if (![add, modify, remove, adopt, investigate].every(isCappedCount)) {
        return fail(400, 'invalid counter (must be an integer 0-50)')
      }
      return {
        ok: true,
        payload: {
          event: 'intent_sent',
          add: add as number,
          modify: modify as number,
          remove: remove as number,
          adopt: adopt as number,
          investigate: investigate as number,
        },
      }
    }

    case 'scan_run': {
      const { provider, nodes_bucket } = payload
      if (typeof provider !== 'string' || !(PROVIDERS as readonly string[]).includes(provider)) {
        return fail(400, 'invalid provider')
      }
      if (typeof nodes_bucket !== 'string' || !(NODES_BUCKETS as readonly string[]).includes(nodes_bucket)) {
        return fail(400, 'invalid nodes_bucket')
      }
      return { ok: true, payload: { event: 'scan_run', provider: provider as Provider, nodes_bucket: nodes_bucket as NodesBucket } }
    }

    case 'drift_opened': {
      const { nodes_bucket } = payload
      if (typeof nodes_bucket !== 'string' || !(NODES_BUCKETS as readonly string[]).includes(nodes_bucket)) {
        return fail(400, 'invalid nodes_bucket')
      }
      return { ok: true, payload: { event: 'drift_opened', nodes_bucket: nodes_bucket as NodesBucket } }
    }
  }
}

/** The hard allowlist: schema version, envelope keys, top-level field shapes,
 *  and (via validatePayload) the event name + its per-event payload keys.
 *  Anything outside this is rejected with 400 — nothing is ever silently
 *  stripped, so a bug that starts sending an extra field is loud, not
 *  quietly swallowed. */
function validateEnvelope(body: unknown): ValidationResult {
  if (!isRecord(body)) return fail(400, 'invalid envelope')
  if (!hasOnlyKeys(body, ENVELOPE_KEYS)) return fail(400, 'unknown field')

  if (body.schema !== 1) return fail(400, 'unsupported schema version')

  if (typeof body.anon_id !== 'string' || !UUID_RE.test(body.anon_id)) return fail(400, 'invalid anon_id')

  if (typeof body.day !== 'string' || !DAY_RE.test(body.day) || Number.isNaN(Date.parse(body.day))) {
    return fail(400, 'invalid day')
  }

  if (typeof body.app_version !== 'string' || body.app_version.length === 0) {
    return fail(400, 'invalid app_version')
  }

  if (typeof body.platform !== 'string' || !(PLATFORMS as readonly string[]).includes(body.platform)) {
    return fail(400, 'invalid platform')
  }

  if (typeof body.node_major !== 'number' || !Number.isInteger(body.node_major) || body.node_major < 0) {
    return fail(400, 'invalid node_major')
  }

  const payloadResult = validatePayload(body.payload)
  if (!payloadResult.ok) return payloadResult

  return {
    ok: true,
    envelope: {
      schema: 1,
      anon_id: body.anon_id,
      day: body.day,
      app_version: body.app_version,
      platform: body.platform as Platform,
      node_major: body.node_major,
      payload: payloadResult.payload,
    },
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** Fixed-width Analytics Engine row so every event lands in the same column
 *  layout regardless of which payload shape produced it — see schema.sql
 *  for the blob/double index mapping and the week-2 reopen query. Never
 *  reads or stores the caller's IP (no `cf-connecting-ip` access) or any
 *  cookie. */
function writeAnalytics(env: Env, envelope: TelemetryEnvelope): void {
  const p = envelope.payload
  env.EVENTS.writeDataPoint({
    blobs: [
      p.event,
      envelope.anon_id,
      envelope.day,
      envelope.app_version,
      envelope.platform,
      'nodes_bucket' in p ? p.nodes_bucket : '',
      'tf_bin' in p ? p.tf_bin : '',
      'provider' in p ? p.provider : '',
    ],
    doubles: [
      envelope.node_major,
      'add' in p ? p.add : 0,
      'modify' in p ? p.modify : 0,
      'remove' in p ? p.remove : 0,
      'adopt' in p ? p.adopt : 0,
      'investigate' in p ? p.investigate : 0,
    ],
    indexes: [p.event],
  })
}

/** Raw-envelope mirror: one object per event, one NDJSON line each, keyed
 *  under the event's UTC day so `events/YYYY-MM-DD/*.ndjson` (concatenated)
 *  is the long-term system of record once Analytics Engine's ~90-day
 *  retention rolls off — see schema.sql for the duckdb-over-R2 fallback
 *  query. */
async function mirrorToR2(env: Env, envelope: TelemetryEnvelope): Promise<void> {
  const key = `events/${envelope.day}/${crypto.randomUUID()}.ndjson`
  await env.BUCKET.put(key, `${JSON.stringify(envelope)}\n`)
}

async function handleEvent(request: Request, env: Env): Promise<Response> {
  const contentLength = request.headers.get('content-length')
  if (contentLength !== null && Number(contentLength) > MAX_BODY_BYTES) {
    return json({ error: 'payload too large' }, 413)
  }

  const rawBody = await request.text()
  if (new TextEncoder().encode(rawBody).length > MAX_BODY_BYTES) {
    return json({ error: 'payload too large' }, 413)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return json({ error: 'invalid json' }, 400)
  }

  const result = validateEnvelope(parsed)
  if (!result.ok) return json({ error: result.error }, result.status)

  // Best-effort, independently: an Analytics Engine or R2 failure never
  // turns into an error response — "client must never see backpressure"
  // (docs/SPEC.md, Error handling). Promise.allSettled also converts any
  // *synchronous* throw from writeDataPoint into a settled rejection, since
  // it's wrapped in an async arrow here.
  await Promise.allSettled([
    (async () => writeAnalytics(env, result.envelope))(),
    mirrorToR2(env, result.envelope),
  ])

  return new Response(null, { status: 204 })
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ status: 'ok' }, 200)
    }

    if (request.method === 'POST' && url.pathname === '/e') {
      return handleEvent(request, env)
    }

    // Everything else — including GET /e, any method on /health, unknown
    // paths, and CORS preflight OPTIONS requests (no CORS headers are ever
    // set anywhere in this worker; there is no browser client for /e, only
    // server-side `fetch` calls from stackcanvas's own TelemetryClient).
    return json({ error: 'not found' }, 404)
  },
}
