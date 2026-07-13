// stackcanvas telemetry collector — event validation — issue #35.
//
// Pure validation module, ported from telemetry-worker/src/index.ts's
// `validateEnvelope`/`validatePayload` as part of the Cloudflare Worker ->
// AWS Lambda migration. Zero AWS imports on purpose: this module only
// touches plain JS/TS (JSON.parse, RegExp, TextEncoder) so it is fully
// unit-testable with no Lambda runtime, no API Gateway event shape, no
// network. See src/handler.ts for the Lambda-specific wiring (routing,
// Firehose) that calls into this.
//
// The envelope/payload shapes below intentionally duplicate (rather than
// import) packages/server/src/telemetry.ts's types: this package is NOT
// part of the pnpm workspace (see package.json) and ships as a single
// bundled Lambda with no monorepo dependency, so the collector's allowlist
// must be self-contained. Keep the two in sync by hand — TELEMETRY.md is the
// document of record for the schema either side must match.

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

/** A validated envelope, ready to be stamped with `received_at` and shipped
 *  to Firehose by src/handler.ts. Same shape as the old worker's
 *  `TelemetryEnvelope` — renamed to `ValidatedEvent` to match this module's
 *  `validateEvent()` entry point. */
export interface ValidatedEvent {
  schema: 1
  anon_id: string
  day: string
  app_version: string
  platform: Platform
  node_major: number
  payload: TelemetryProps
}

/** Envelope allowlist — the "hard allowlist" the original design requires:
 *  any key outside this set is a 400, not a silent strip (a stripping
 *  collector would mask exactly the accidental-field-growth bug this schema
 *  exists to catch — see the client-side "envelope allowlist tripwire" test
 *  this mirrors, packages/server/src/telemetry.test.ts). */
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

export type ValidateResult = { ok: true; event: ValidatedEvent } | { ok: false; status: number; error: string }

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

/** The hard allowlist: envelope keys, top-level field shapes, and (via
 *  validatePayload) the event name + its per-event payload keys. Anything
 *  outside this is rejected with 400 — nothing is ever silently stripped,
 *  so a bug that starts sending an extra field is loud, not quietly
 *  swallowed. Schema-version and size checks happen one level up, in
 *  `validateEvent()`, since they apply before this function ever sees an
 *  object. */
function validateEnvelope(body: unknown): ValidateResult {
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
    event: {
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

/** Entry point: validates a raw request body string end to end — size,
 *  JSON well-formedness, then the envelope/payload allowlist above.
 *
 *  Size is checked on the decoded body string itself (there is no
 *  Content-Length-header short-circuit here, unlike the old Cloudflare
 *  Worker: API Gateway has already buffered the whole body into
 *  `event.body` before Lambda ever runs, so there is no earlier point at
 *  which this module could reject a request without reading the body). */
export function validateEvent(body: string): ValidateResult {
  if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) {
    return fail(413, 'payload too large')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return fail(400, 'invalid json')
  }

  return validateEnvelope(parsed)
}
